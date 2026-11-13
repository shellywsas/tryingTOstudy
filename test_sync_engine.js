// Sync engine tests: real engine + firestorePort adapter over an in-memory Firestore-compat fake. No sleeps, no network.
const assert = require('assert');
const H = require('./js/sync-helpers.js');
const { createSyncEngine, firestorePort, normalizeUsername } = require('./js/sync-engine.js');

// ---------------- fakes
function makeFakeFirestore() {
    const docs = {}; // id -> {data, ver}
    const listeners = []; // {id,next,err}
    const f = {
        docs, writes: 0, partition: false, failWrite: null, ackLost: false, getFail: null, hangGet: false, hangListen: false,
        listeners,
        _notify(id) { for (const l of listeners.slice()) if (l.id === id && !l.dead) { const d = docs[id]; Promise.resolve().then(() => !l.dead && l.next({ exists: !!d, data: () => JSON.parse(JSON.stringify(d.data)), metadata: { fromCache: false } })); } },
        dropListeners(err) { for (const l of listeners.slice()) { if (!l.dead) { l.dead = true; l.err(err || Object.assign(new Error('stream closed'), { code: 'unavailable' })); } } },
        collection() { return { doc: (id) => ({ id, get: async () => {
            if (f.partition) throw Object.assign(new Error('offline'), { code: 'unavailable' });
            if (f.hangGet) return new Promise(() => {});
            if (f.getFail) throw f.getFail;
            const d = docs[id];
            return { exists: !!d, data: () => JSON.parse(JSON.stringify(d.data)), metadata: { fromCache: false } };
        }, onSnapshot: (next, err) => {
            const l = { id, next, err, dead: false }; listeners.push(l);
            if (f.hangListen) return () => { l.dead = true; };
            if (f.partition) { l.dead = true; Promise.resolve().then(() => err(Object.assign(new Error('offline'), { code: 'unavailable' }))); }
            else f._notify(id);
            return () => { l.dead = true; };
        } }) }; },
        gate: null,
        async runTransaction(fn) {
            for (let attempt = 0; attempt < 5; attempt++) {
                if (f.partition) throw Object.assign(new Error('offline'), { code: 'unavailable' });
                const readVer = {}; let pending = null;
                const tx = {
                    get: async (ref) => { const d = docs[ref.id]; readVer[ref.id] = d ? d.ver : 0; return { exists: !!d, data: () => JSON.parse(JSON.stringify(d.data)) }; },
                    set: (ref, data) => { pending = { id: ref.id, data: JSON.parse(JSON.stringify(data)) }; },
                };
                await fn(tx);
                if (f.gate) await f.gate;
                if (f.failWrite && pending) throw f.failWrite;
                if (pending) {
                    const cur = docs[pending.id] ? docs[pending.id].ver : 0;
                    if (cur !== readVer[pending.id]) continue; // conflict: retry
                    docs[pending.id] = { data: pending.data, ver: cur + 1 };
                    f.writes++;
                    f._notify(pending.id);
                    if (f.ackLost) throw Object.assign(new Error('ack lost'), { code: 'unavailable' });
                }
                return;
            }
            throw new Error('too much contention');
        },
    };
    return f;
}
function makeStorage(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; }
function makeTimers() {
    let t = 0, seq = 0; const q = [];
    return { set: (fn, ms) => { const id = ++seq; q.push({ id, at: t + ms, fn }); return id; }, clear: (id) => { const i = q.findIndex((x) => x.id === id); if (i >= 0) q.splice(i, 1); },
        advance(ms) { t += ms; q.sort((a, b) => a.at - b.at); while (q.length && q[0].at <= t) q.shift().fn(); }, now: () => t };
}
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const NOW = Date.now();
function task(id, extra) { return { id, title: id, dueDate: '2099-01-01', completed: false, updatedAt: NOW - 1000, ...extra }; }
function mkUser(tasks, extra) { return { username: 'u', name: 'u', tasks, pointsHistory: [], streakHistory: [], taskStreak: 0, longestStreak: 0, totalPoints: 0, weeklyPoints: 0, lastSync: NOW - 5000, ...extra }; }

function device(fake, storage, startDoc, opts) {
    const store = { doc: startDoc || null };
    const timers = (opts && opts.timers) || makeTimers();
    const eng = createSyncEngine({
        helpers: (opts && opts.helpers) || H, db: firestorePort(fake), storage, timers, now: () => NOW + ((opts && opts.skew) || 0), buildId: 'test-build',
        getLocal: () => store.doc,
        applyLocal: (m, o) => { store.doc = H.mergeUserData(o && o.stripUnedited ? require('./js/sync-engine.js').stripUneditedScalars(store.doc) : store.doc, m, undefined, { now: NOW }); },
    });
    const mutate = (fn) => { const d = fn(store.doc); d.lastSync = NOW + (++mutate.n); store.doc = d; eng.localMutation(d); };
    mutate.n = 0;
    return { eng, store, timers, mutate };
}
const hashDoc = (d) => H.contentHash(JSON.parse(JSON.stringify(d)));

(async () => {
    let n = 0; const ok = (m) => { n++; console.log('[PASS] ' + m); };

    // 1. new phone, empty local, cloud has data: nothing pushed before the first successful pull; cloud data survives
    {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: mkUser([task('c1'), task('c2')], { lastSync: NOW - 100000 }) };
        fake.partition = true;
        const d = device(fake, makeStorage(), mkUser([], { lastSync: NOW })); // empty/default local with a NEWER lastSync
        d.eng.setUser('u'); await tick();
        d.mutate((u) => ({ ...u, theme: 'dark', fieldUpdatedAt: { theme: NOW } })); await tick();
        assert.strictEqual(fake.writes, 0, 'no write before first pull');
        assert.notStrictEqual(d.eng.getStatus().state, 'synced');
        fake.partition = false; await d.eng.retry(); await tick();
        assert.deepStrictEqual(d.store.doc.tasks.map((t) => t.id).sort(), ['c1', 'c2'], 'cloud tasks adopted');
        assert.deepStrictEqual(fake.docs.u.data.tasks.map((t) => t.id).sort(), ['c1', 'c2'], 'cloud tasks not wiped');
        assert.strictEqual(fake.docs.u.data.theme, 'dark');
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        ok('new phone: empty local pushes nothing before pull, cloud tasks survive, ends green');
    }

    // 2. offline edit + reload keeps outbox, then converges
    {
        const fake = makeFakeFirestore(); const st = makeStorage();
        fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        let d = device(fake, st, mkUser([task('a')])); d.eng.setUser('u'); await tick();
        fake.partition = true; d.eng.setOnline(false);
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('offline-new')] })); await tick();
        assert.ok(st.getItem('studyStreak_outbox_u'), 'outbox persisted');
        const saved = d.store.doc; // the app persists local state itself; the outbox entry holds only {seq,ts}
        assert.deepStrictEqual(Object.keys(JSON.parse(st.getItem('studyStreak_outbox_u'))).sort(), ['fresh', 'seq', 'ts'], 'outbox stores no doc copy');
        // reload: new engine instance, same storage, local state restored from the saved doc
        d = device(fake, st, saved); d.eng.setUser('u'); await tick();
        assert.ok(st.getItem('studyStreak_outbox_u'), 'outbox not purged on load');
        assert.notStrictEqual(d.eng.getStatus().state, 'synced');
        fake.partition = false; d.eng.setOnline(true); await tick(30);
        assert.ok(fake.docs.u.data.tasks.some((t) => t.id === 'offline-new'), 'offline edit reached cloud');
        assert.strictEqual(st.getItem('studyStreak_outbox_u'), null, 'outbox cleared after ack');
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        ok('offline edit survives reload and converges');
    }

    // 3. two engines converge, no ping-pong
    {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const A = device(fake, makeStorage(), mkUser([task('a')])), B = device(fake, makeStorage(), mkUser([task('a')]));
        A.eng.setUser('u'); B.eng.setUser('u'); await tick();
        A.mutate((u) => ({ ...u, tasks: [...u.tasks, task('fromA')] }));
        B.mutate((u) => ({ ...u, tasks: [...u.tasks, task('fromB')] }));
        await tick(40);
        const ids = (d) => d.tasks.map((t) => t.id).sort().join();
        assert.strictEqual(ids(A.store.doc), 'a,fromA,fromB'); assert.strictEqual(ids(B.store.doc), 'a,fromA,fromB'); assert.strictEqual(ids(fake.docs.u.data), 'a,fromA,fromB');
        assert.strictEqual(hashDoc(A.store.doc), hashDoc(B.store.doc));
        assert.strictEqual(A.eng.getStatus().state, 'synced'); assert.strictEqual(B.eng.getStatus().state, 'synced');
        const w = fake.writes; await tick(40); assert.strictEqual(fake.writes, w, 'quiescent: no further writes');
        ok('two devices converge on identical content, both green, writes quiesce');
    }

    // 4. push failure never green; red/amber, backoff retry heals
    {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const d = device(fake, makeStorage(), mkUser([task('a')])); d.eng.setUser('u'); await tick();
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        fake.failWrite = Object.assign(new Error('Missing or insufficient permissions'), { code: 'permission-denied' });
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('x')] })); await tick();
        let s = d.eng.getStatus(); assert.strictEqual(s.state, 'error'); assert.ok(/permission/i.test(s.reason));
        fake.failWrite = null; d.timers.advance(2500); await tick(30);
        assert.strictEqual(d.eng.getStatus().state, 'synced', 'backoff retry heals and clears lastError');
        assert.ok(fake.docs.u.data.tasks.some((t) => t.id === 'x'));
        ok('push failure shows error (never green), backoff retry succeeds and clears it');
    }

    // 5. aborted merge never writes
    {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: { ...mkUser([task('a')]), tasks: 'CORRUPT' } };
        const d = device(fake, makeStorage(), mkUser([task('a')])); d.eng.setUser('u'); await tick();
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('b')] })); await tick();
        assert.strictEqual(fake.writes, 0); assert.strictEqual(fake.docs.u.data.tasks, 'CORRUPT');
        assert.ok(d.eng._debug().entry, 'outbox kept'); assert.notStrictEqual(d.eng.getStatus().state, 'synced');
        ok('corrupt remote array: merge aborted, nothing written, outbox kept, not green');
    }

    // 6. listener drop and re-attach, remote change arrives afterwards
    {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const d = device(fake, makeStorage(), mkUser([task('a')])); d.eng.setUser('u'); await tick();
        fake.dropListeners(); await tick();
        assert.strictEqual(d.eng.info().listenerState, 'error'); assert.strictEqual(d.eng.getStatus().state, 'error');
        d.timers.advance(2500); await tick();
        assert.strictEqual(d.eng.info().listenerState, 'ok');
        fake.docs.u = { ver: 2, data: { ...fake.docs.u.data, tasks: [task('a'), task('remote-new')], lastSync: NOW + 50 } }; fake._notify('u'); await tick(20);
        assert.ok(d.store.doc.tasks.some((t) => t.id === 'remote-new'));
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        ok('listener drop shows error, re-attaches with backoff, later remote change applied');
    }

    // 6b. real-browser finding: a hung Firestore get/listener (no answer, no error) must not leave a fresh device amber forever
    {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: mkUser([task('a'), task('cloud-only')]) };
        fake.hangGet = true; fake.hangListen = true;
        const d = device(fake, makeStorage(), mkUser([task('a')])); d.eng.setUser('u'); await tick();
        assert.notStrictEqual(d.eng.getStatus().state, 'synced');
        d.timers.advance(16000); await tick();
        assert.ok(/timeout|no response/i.test(String(d.eng.info().lastError || '')), 'hang surfaced as an error, not silent');
        assert.strictEqual(d.eng.info().listenerState, 'error');
        fake.hangGet = false; fake.hangListen = false;
        for (let i = 0; i < 8; i++) { d.timers.advance(8000); await tick(); }
        assert.ok(d.store.doc.tasks.some((t) => t.id === 'cloud-only'), 'retried pull brings cloud data');
        assert.strictEqual(d.eng.info().listenerState, 'ok');
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        ok('hung get/listener: timeout error shown, pull and listener retried, converges to green');
    }

    // 7. ack-only clear: write applied but ack lost -> outbox kept; retry idempotent, then cleared
    {
        const fake = makeFakeFirestore(); const st = makeStorage();
        fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const d = device(fake, st, mkUser([task('a')])); d.eng.setUser('u'); await tick();
        fake.ackLost = true;
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('y')] })); await tick();
        assert.ok(st.getItem('studyStreak_outbox_u'), 'no ack, outbox stays');
        assert.notStrictEqual(d.eng.getStatus().state, 'synced');
        fake.ackLost = false; d.timers.advance(2500); await tick(30);
        assert.strictEqual(st.getItem('studyStreak_outbox_u'), null);
        assert.strictEqual(fake.docs.u.data.tasks.filter((t) => t.id === 'y').length, 1, 'no duplicate');
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        ok('outbox cleared only on ack; lost ack retried idempotently');
    }

    // 8. edit during in-flight push is not cleared by the older ack
    {
        const fake = makeFakeFirestore(); const st = makeStorage();
        fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const d = device(fake, st, mkUser([task('a')])); d.eng.setUser('u'); await tick();
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('p1')] }));
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('p2')] })); // second edit while first push is in flight
        await tick(40);
        assert.deepStrictEqual(fake.docs.u.data.tasks.map((t) => t.id).sort(), ['a', 'p1', 'p2']);
        assert.strictEqual(st.getItem('studyStreak_outbox_u'), null);
        ok('newer edit during an in-flight push is pushed too, not lost to the older ack');
    }

    // 9. status table honesty
    {
        const base = { online: true, pullOk: true, outboxCount: 0, lastPushAckAt: 1, localHash: 'h', cloudHash: 'h', lastError: null };
        const st = (x) => H.computeSyncStatus({ ...base, ...x }).state;
        assert.strictEqual(st({}), 'synced');
        for (const bad of [{ online: false }, { pullOk: false }, { outboxCount: 2 }, { lastPushAckAt: null }, { cloudHash: 'z' }, { cloudHash: null }, { lastError: 'x' }]) assert.notStrictEqual(st(bad), 'synced', JSON.stringify(bad));
        ok('status table: green only when all five conditions hold');
    }

    // 10. username normalisation (U8)
    assert.strictEqual(normalizeUsername('  ענבר​‏❤‫ '), 'ענבר❤');
    assert.strictEqual(normalizeUsername('a️'), 'a'); assert.strictEqual(normalizeUsername('👩‍💻'), '👩‍💻', 'ZWJ kept');
    assert.strictEqual(normalizeUsername('é'), 'é', 'NFC');
    assert.ok(!require('./js/sync-engine.js').isValidDocId('a/b'));
    ok('username normalisation: strips invisible marks only, keeps ZWJ, NFC, rejects /');

    // 11 (U2). skewed engines, delete vs add: quiescent quickly, bounded writes
    for (const skew of [[600000, -600000], [31536000000, -31536000000]]) {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: mkUser([task('a'), task('b')]) };
        const A = device(fake, makeStorage(), mkUser([task('a'), task('b')]), { skew: skew[0] }), B = device(fake, makeStorage(), mkUser([task('a'), task('b')]), { skew: skew[1] });
        A.eng.setUser('u'); B.eng.setUser('u'); await tick();
        A.mutate((u) => ({ ...u, tasks: u.tasks.filter((t) => t.id !== 'b'), deletedTaskIds: ['b'] }));
        B.mutate((u) => ({ ...u, tasks: [...u.tasks, task('n')] }));
        await tick(40);
        const w = fake.writes; assert.ok(w <= 12, 'bounded writes: ' + w);
        await tick(60); assert.strictEqual(fake.writes, w, 'quiescent');
        assert.strictEqual(hashDoc(A.store.doc), hashDoc(B.store.doc), 'converged');
        assert.deepStrictEqual(A.store.doc.tasks.map((t) => t.id).sort(), ['a', 'n']);
    }
    ok('U2: +/-10 min and +/-1 year skew, delete vs add: converge, quiescent, bounded writes');

    // 12 (U3). continue locally on a new phone, add a task, reconnect: cloud settings intact
    {
        const fake = makeFakeFirestore();
        fake.docs.u = { ver: 1, data: mkUser([task('c1')], { theme: 'dark', phoneNumber: '050', lastSync: NOW - 100000 }) };
        fake.partition = true;
        const fresh = (u) => !u || H.isEmptyLocal(u) || (!u.lastSync && !(u.tasks || []).length && !(u.pointsHistory || []).length);
        const d = device(fake, makeStorage(), { username: 'u', name: 'תלמיד/ה', theme: 'light', phoneNumber: '', tasks: [], pointsHistory: [] }, { helpers: { ...H, isEmptyLocal: fresh } });
        d.eng.setUser('u'); d.eng.setOnline(false); await tick();
        d.mutate((u) => ({ ...u, tasks: [task('mine')] })); await tick();
        assert.strictEqual(fake.writes, 0);
        fake.partition = false; d.eng.setOnline(true); await tick(40);
        assert.strictEqual(fake.docs.u.data.theme, 'dark'); assert.strictEqual(fake.docs.u.data.phoneNumber, '050');
        assert.deepStrictEqual(fake.docs.u.data.tasks.map((t) => t.id).sort(), ['c1', 'mine']);
        ok('U3: continue-locally copy never overwrites cloud settings; first push merges through the transaction');
    }

    // 13. U7/U11/U12
    {
        const fake = makeFakeFirestore(); const st = makeStorage({ studyStreak_outbox_u: '{not json' });
        fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const d = device(fake, st, mkUser([task('a')])); d.eng.setUser('u'); await tick();
        assert.ok([...st.m.keys()].some((k) => k.startsWith('studyStreak_outbox_u_corrupt_')), 'corrupt entry parked');
        assert.strictEqual(st.getItem('studyStreak_outbox_u'), null);
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        fake.dropListeners(); await tick();
        assert.notStrictEqual(d.eng.getStatus().state, 'synced');
        const origSet = st.setItem; st.setItem = () => { throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }); };
        fake.partition = true;
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('q')] })); await tick();
        assert.ok(d.eng.getStatus().state === 'error' && d.eng.getStatus().reason === 'storage_full', JSON.stringify(d.eng.getStatus()));
        st.setItem = origSet;
        d.eng.setUser('other'); assert.strictEqual(d.eng.info().docId, 'other'); await tick();
        ok('U7/U11/U12: user switch epoch, corrupt outbox parked, storage_full surfaced, dropped listener not green');
    }

    // 15. skipped flush in flight while a newer listener snapshot is accepted: stale tx-time read must not set cloudHash
    {
        const fake = makeFakeFirestore(); fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const d = device(fake, makeStorage(), mkUser([task('a')])); d.eng.setUser('u'); await tick();
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        let release; fake.gate = new Promise((r) => { release = r; });
        d.mutate((u) => ({ ...u })); await tick(5); // lastSync-only edit: the flush computes a skipped write and parks on the gate
        fake.docs.u = { ver: 2, data: { ...fake.docs.u.data, tasks: [task('a'), task('x')], lastSync: NOW + 10 } }; fake._notify('u'); await tick(5);
        assert.ok(d.store.doc.tasks.some((t) => t.id === 'x'), 'newer snapshot accepted');
        fake.gate = null; release(); await tick(20);
        assert.strictEqual(d.eng.getStatus().state, 'synced', JSON.stringify(d.eng.getStatus()));
        ok('stale transaction-time read does not overwrite a newer snapshot cloudHash');
    }
    // 16 (F1). stuck no_cloud_doc + explicit create-from-local; second device pulls; never overwrites an existing doc
    {
        const fake = makeFakeFirestore();
        const A = device(fake, makeStorage(), mkUser([task('mine1'), task('mine2')], { theme: 'dark' })); A.eng.setUser('acct'); await tick();
        assert.deepStrictEqual(A.eng.getStatus(), { state: 'pending', reason: 'no_cloud_doc' }); assert.strictEqual(fake.writes, 0);
        assert.strictEqual(await A.eng.createFromLocal(), 'created'); await tick(10);
        assert.deepStrictEqual(fake.docs.acct.data.tasks.map((t) => t.id).sort(), ['mine1', 'mine2']);
        assert.strictEqual(A.eng.getStatus().state, 'synced');
        assert.strictEqual(A.store.doc.tasks.length, 2, 'local data untouched');
        const B = device(fake, makeStorage(), mkUser([], { lastSync: 0, theme: 'light' })); B.eng.setUser('acct'); await tick(20);
        assert.deepStrictEqual(B.store.doc.tasks.map((t) => t.id).sort(), ['mine1', 'mine2'], 'second device pulls the data');
        // existing cloud doc: create-only must not overwrite; engine pulls instead
        const C = device(fake, makeStorage(), mkUser([task('other')])); C.eng.setUser('acct'); await tick(20);
        const w = fake.writes; fake.docs.acct.data.tasks = fake.docs.acct.data.tasks.slice();
        const port = firestorePort(fake);
        const r = await port.createOnly('acct', { tasks: [], username: 'x' }); assert.ok(r.existing && !r.created); assert.strictEqual(fake.writes, w, 'create-only wrote nothing');
        assert.strictEqual(await C.eng.createFromLocal(), 'existing');
        assert.ok(fake.docs.acct.data.tasks.some((t) => t.id === 'mine1'), 'cloud doc intact');
        ok('F1: create-from-local is create-only, keeps local data, second device pulls it, existing doc is never overwritten');
    }
    // 17 (L2/L3). mutation during the create transaction survives; password mismatch never merges
    {
        const fake = makeFakeFirestore();
        const d = device(fake, makeStorage(), mkUser([task('m1')], { password: 'p1' })); d.eng.setUser('acct'); await tick();
        let release; fake.gate = new Promise((r) => { release = r; });
        const p = d.eng.createFromLocal(); await tick(5);
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('during')] })); await tick(5);
        fake.gate = null; release(); assert.strictEqual(await p, 'created'); await tick(30);
        assert.deepStrictEqual(fake.docs.acct.data.tasks.map((t) => t.id).sort(), ['during', 'm1'], 'mutation during create not lost');
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        const f2 = makeFakeFirestore();
        const e = device(f2, makeStorage(), mkUser([task('loc')], { password: 'mine' })); e.eng.setUser('acct'); await tick(10);
        f2.docs.acct = { ver: 1, data: mkUser([task('cloud')], { password: 'other' }) }; // appears after the local-only account got stuck
        assert.strictEqual(await e.eng.createFromLocal(), 'failed');
        await e.eng.poll(); await tick(10);
        assert.deepStrictEqual(e.store.doc.tasks.map((t) => t.id), ['loc'], 'local untouched, no merge');
        assert.deepStrictEqual(f2.docs.acct.data.tasks.map((t) => t.id), ['cloud'], 'cloud untouched');
        assert.strictEqual(e.eng.getStatus().reason, 'password_mismatch');
        ok('L2/L3: mutation during create survives; password mismatch blocks merge and push');
    }
    // 14 (R10). unknown user that exists only in localStorage never auto-creates a cloud doc
    {
        const fake = makeFakeFirestore();
        const d = device(fake, makeStorage(), mkUser([task('t')])); d.eng.setUser('בדיקה'); await tick();
        d.mutate((u) => ({ ...u, tasks: [...u.tasks, task('t2')] })); await tick(); await d.eng.poll(); await tick();
        assert.strictEqual(fake.writes, 0); assert.strictEqual(fake.docs['בדיקה'], undefined, 'no stray cloud doc');
        assert.deepStrictEqual(d.eng.getStatus(), { state: 'pending', reason: 'no_cloud_doc' });
        // explicit create-account flow makes the doc; the next poll converges through the normal merge
        fake.docs['בדיקה'] = { ver: 1, data: mkUser([], { lastSync: NOW - 5 }) };
        await d.eng.poll(); await tick(30);
        assert.deepStrictEqual(fake.docs['בדיקה'].data.tasks.map((t) => t.id).sort(), ['t', 't2']);
        ok('R10: engine never creates a cloud doc for a local-only user; converges once the doc exists');
    }
    // R2/R3: storage error from the app's main write turns the dot red; refreshOnline does not kick when unchanged
    {
        const fake = makeFakeFirestore(); fake.docs.u = { ver: 1, data: mkUser([task('a')]) };
        const d = device(fake, makeStorage(), mkUser([task('a')])); d.eng.setUser('u'); await tick();
        d.eng.setStorageError(true); assert.deepStrictEqual(d.eng.getStatus(), { state: 'error', reason: 'storage_full' });
        d.eng.setStorageError(false); assert.strictEqual(d.eng.getStatus().state, 'synced');
        const before = fake.writes; d.eng.refreshOnline(true); await tick(); assert.strictEqual(fake.writes, before);
        d.eng.refreshOnline(false); assert.strictEqual(d.eng.getStatus().state, 'offline'); d.eng.refreshOnline(true); await tick(20);
        assert.strictEqual(d.eng.getStatus().state, 'synced');
        ok('R2/R3: storage error is red, refreshOnline tracks navigator.onLine');
    }
    console.log(`sync-engine: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
