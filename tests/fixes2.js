// Fix pass 2 (M1-M5, L1-L7). Dates are Jerusalem wall time (J) so results do not depend on the host TZ.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const sync = require('../js/sync-helpers.js');
const helpers = require('../js/helpers.js');
const { test, mulberry32 } = require('./harness.js');
const J = sync.jerusalemMs;
const iso = (ms) => new Date(ms).toISOString();
const NOW = J(2026, 11, 13, 12);
const hw = (o = {}) => ({ id: 't1', title: 'ש', subjectId: 's1', dueDate: '2026-11-12', dueTime: '22:00', ...o });
const base = (o = {}) => ({ username: 'u', name: 'u', tasks: [], pointsHistory: [], streakHistory: [], exams: [], badges: [],
    deletedTaskIds: [], deletedExamIds: [], taskStreak: 0, longestStreak: 0, lastSync: 0, ...o });
const mg = (a, b, now = NOW) => sync.mergeUserData(a, b, undefined, { now });
const H = (u) => sync.contentHash(u);
const DUE = J(2026, 11, 12, 22);

test('M1 opening balance: no false mint when a side explains its total or sides disagree', () => {
    const r1 = { id: 'r1', taskId: 'a', points: 2, date: iso(NOW - 1e7) };
    const spend = { id: 'sp', taskId: 'b', points: -1, date: iso(NOW - 5e6) };
    const A = base({ lastSync: 1, totalPoints: 2, pointsHistory: [r1] });
    const B = base({ lastSync: 2, totalPoints: 1, pointsHistory: [r1, spend] });
    for (const m of [mg(A, B), mg(B, A)]) {
        assert.ok(!m.pointsHistory.some(r => r.id === 'ph_opening_balance'));
        assert.strictEqual(m.totalPoints, 1);
    }
    const Bc = base({ lastSync: 2, totalPoints: 2, pointsHistory: [{ ...r1, canceled: true }] });
    for (const m of [mg(A, Bc), mg(Bc, A)]) assert.ok(!m.pointsHistory.some(r => r.id === 'ph_opening_balance'));
    // both sides non-empty ledger, both unexplained: still no mint during a two-sided merge (heal on a single device mints)
    const C = base({ lastSync: 3, totalPoints: 9, pointsHistory: [r1] }), D = base({ lastSync: 4, totalPoints: 9, pointsHistory: [r1] });
    assert.ok(!mg(C, D).pointsHistory.some(r => r.id === 'ph_opening_balance'));
    // single device migration still mints; empty-ledger side + unexplained side mints from the ledger side
    assert.strictEqual(sync.healCompletedFromHistory(C, NOW).pointsHistory.find(r => r.id === 'ph_opening_balance').points, 7);
    const E = base({ lastSync: 1, totalPoints: 100 });
    assert.strictEqual(mg(E, C).totalPoints, 9);
});

test('M2 Firestore Timestamp / numeric-string completedAt classify lateness correctly', () => {
    const lateMs = DUE + 3 * 3600000, okMs = DUE - 3600000;
    const forms = (ms) => [{ seconds: Math.floor(ms / 1000), nanoseconds: 0 }, { toMillis: () => ms }, String(ms), ms, iso(ms)];
    for (const f of forms(lateMs)) assert.strictEqual(sync.isTaskSubmittedOnTime(hw({ completed: true, completedAt: f })), false);
    for (const f of forms(okMs)) assert.strictEqual(sync.isTaskSubmittedOnTime(hw({ completed: true, completedAt: f })), true);
    for (const f of forms(lateMs)) {
        const u = { tasks: [hw({ completed: true, completedAt: f, autoPenaltyApplied: true })], pointsHistory: [{ id: 'x', taskId: 'z', points: 1, date: iso(NOW) }] };
        const h = sync.healCompletedFromHistory(u, NOW);
        assert.ok(h.pointsHistory.some(r => r.id === `ph_pen1_t1_${DUE}`), 'late stays late');
        assert.ok(!h.pointsHistory.some(r => r.id.startsWith('ph_healed_')));
    }
    for (const f of forms(lateMs)) assert.strictEqual(helpers.calculateTaskExpectedPoints({ id: 't', createdAt: iso(DUE - 5 * 86400000), dueDate: '2026-11-12', dueTime: '22:00', completedAt: f }), 1);
    for (const f of forms(DUE - 4 * 86400000)) assert.strictEqual(helpers.calculateTaskExpectedPoints({ id: 't', createdAt: iso(DUE - 5 * 86400000), dueDate: '2026-11-12', dueTime: '22:00', completedAt: f }), 2);
});

test('M3 refund dated at max(completedAt, penalty date) so it never lands in an earlier week', () => {
    const pen = { id: `ph_pen1_t1_${DUE}`, taskId: 't1', points: -1, date: iso(J(2026, 11, 15, 12)), catchUp: true, dueMs: DUE };
    const u = { tasks: [hw({ completed: true, completedAt: iso(DUE - 3600000), autoPenaltyApplied: true })], pointsHistory: [pen, { id: 'k', taskId: 'z', points: 1, date: iso(J(2026, 11, 15, 13)) }] };
    const h = sync.healCompletedFromHistory(u, J(2026, 11, 16, 9));
    const rf = h.pointsHistory.find(r => r.id === 'ph_refund_' + pen.id);
    assert.ok(new Date(rf.date).getTime() >= new Date(pen.date).getTime());
    assert.strictEqual(sync.sumLedger(h.pointsHistory, { from: sync.getWindowStart(J(2026, 11, 16, 9)) }), 1);
});

test('M4 results identical in 4 host timezones (ids, dates, totals, streak, window)', () => {
    const out = ['Asia/Jerusalem', 'UTC', 'America/New_York', 'Pacific/Kiritimati'].map(tz =>
        execFileSync(process.execPath, [path.join(__dirname, 'xtz_child.js')], { env: { ...process.env, TZ: tz } }).toString().trim());
    for (const o of out) assert.strictEqual(o, out[0], 'tz-dependent result:\n' + out.join('\n'));
    const r = JSON.parse(out[0]);
    assert.strictEqual(r.pen.length, 1);
    assert.strictEqual(r.due, Date.parse('2026-11-12T20:00:00Z')); // 22:00 Asia/Jerusalem (UTC+2)
    assert.strictEqual(r.dueDO, Date.parse('2026-03-27T20:59:59Z')); // 23:59:59 on the DST-start day (UTC+3 after 03:00)? checked below
});

test('M4 other-TZ legacy penalty ids dedupe by (task, step) and are not re-minted', () => {
    const t = hw();
    const variants = [DUE + 2 * 3600000, DUE - 5 * 3600000, DUE + 9 * 3600000];
    for (const v of variants) {
        const legacy = [{ id: `ph_pen1_t1_${v}`, taskId: 't1', points: -1, date: iso(v), dueMs: v }];
        assert.deepStrictEqual(sync.penaltyRowsFor(t, DUE + 600000, legacy, [], { now: DUE + 600000 }), [], 'variant ' + v);
    }
    const dup = [
        { id: `ph_pen1_t1_${DUE}`, taskId: 't1', points: -1, date: iso(DUE), dueMs: DUE },
        { id: `ph_pen1_t1_${DUE + 7200000}`, taskId: 't1', points: -1, date: iso(DUE + 7200000), dueMs: DUE + 7200000 },
        { id: `ph_refund_ph_pen1_t1_${DUE + 7200000}`, taskId: 't1', points: 1, date: iso(DUE + 8000000) },
    ];
    const A = base({ lastSync: 1, tasks: [hw({ completed: true, completedAt: iso(DUE + 600000), updatedAt: 1 })], pointsHistory: dup.slice(0, 1) });
    const B = base({ lastSync: 2, tasks: [hw({ completed: true, completedAt: iso(DUE + 600000), updatedAt: 1 })], pointsHistory: dup.slice(1, 2) });
    const m = mg(A, B), m2 = mg(B, A);
    assert.strictEqual(m.pointsHistory.filter(r => /^ph_pen1_/.test(r.id)).length, 1);
    assert.strictEqual(sync.sumLedger(m.pointsHistory, {}), -1);
    assert.strictEqual(H(m), H(m2));
});

test('M4 getWindowStart/getDueMs are Jerusalem based (DST days)', () => {
    assert.strictEqual(sync.getWindowStart(J(2026, 10, 25, 12)), J(2026, 10, 25, 0));
    assert.strictEqual(sync.getWindowStart(J(2026, 10, 24, 23, 59)), J(2026, 10, 18, 0));
    assert.strictEqual(sync.getWindowStart(J(2026, 10, 25, 0)), J(2026, 10, 25, 0));
    assert.strictEqual(sync.getDueMs({ dueDate: '2026-10-25', dueTime: '22:00' }), J(2026, 10, 25, 22));
    assert.strictEqual(sync.getDueMs({ dueDate: '2026-03-28' }), J(2026, 3, 28, 23, 59, 59));
    assert.strictEqual(J(2026, 11, 12, 22), Date.parse('2026-11-12T20:00:00Z'));
    assert.strictEqual(J(2026, 7, 1, 12), Date.parse('2026-07-01T09:00:00Z'));
});

// ---- M5: property test with due edits + refunds + sweeps ----
function sim(seed, n, steps) {
    const rnd = mulberry32(seed); let tick = 1000, nid = 0;
    const reps = Array.from({ length: n }, () => base({ theme: 't0', subjects: [{ id: 's1', name: 'm', emoji: 'x' }] }));
    const nowOf = () => J(2026, 11, 10, 8) + (++tick) * 600000;
    const ops = [
        (r) => { const id = 't' + (nid++); const s = ++tick; const d = nowOf() + (rnd() * 90 - 40) * 3600000; const dd = new Date(d).toISOString();
            return { ...r, lastSync: s, tasks: [{ id, title: 'n' + s, subjectId: 's1', dueDate: dd.slice(0, 10), dueTime: dd.slice(11, 16), createdAt: s, updatedAt: s }, ...r.tasks] }; },
        (r) => { const open = r.tasks.filter(t => !t.completed); if (!open.length) return r; const t = open[Math.floor(rnd() * open.length)]; const s = ++tick; const at = nowOf();
            const done = { ...t, completed: true, completedAt: iso(at), pointsEarned: 1, updatedAt: s };
            const ev = sync.evaluateLateness(done, at, at);
            if (ev.late) done.autoPenaltyApplied = true;
            const rows = ev.late ? sync.penaltyRowsFor(done, at, r.pointsHistory, r.subjects, { now: at }) : [{ id: 'ph_' + t.id, taskId: t.id, points: 1, date: iso(at) }];
            return { ...r, lastSync: s, tasks: r.tasks.map(x => x.id === t.id ? done : x), pointsHistory: [...rows, ...r.pointsHistory] }; },
        (r) => { let ph = r.pointsHistory, tasks = r.tasks; const at = nowOf(); const s = ++tick; // sweep
            for (const t of r.tasks) { if (t.completed) continue; const rows = sync.penaltyRowsFor(t, at, ph, r.subjects, { now: at }); if (rows.length) { ph = [...rows, ...ph]; tasks = tasks.map(x => x.id === t.id ? { ...x, autoPenaltyApplied: true, updatedAt: s } : x); } }
            return { ...r, lastSync: s, tasks, pointsHistory: ph }; },
        (r) => { const open = r.tasks.filter(t => !t.completed); if (!open.length) return r; const t = open[Math.floor(rnd() * open.length)]; const s = ++tick; // due edit to future + refund
            const nd = new Date(nowOf() + 3 * 86400000).toISOString();
            const edited = { ...t, dueDate: nd.slice(0, 10), dueTime: nd.slice(11, 16), updatedAt: s, autoPenaltyApplied: false };
            const res = sync.restoreOnDueEdit({ ...r, tasks: r.tasks.map(x => x.id === t.id ? edited : x) }, t.id, t.dueDate, sync.getDueMs(edited), nowOf());
            return { ...res, lastSync: s }; },
        (r) => { if (!r.tasks.length) return r; const t = r.tasks[Math.floor(rnd() * r.tasks.length)]; const s = ++tick; return { ...r, lastSync: s, tasks: r.tasks.filter(x => x.id !== t.id), deletedTaskIds: [...r.deletedTaskIds, t.id] }; },
        (r) => { const s = ++tick; return { ...r, lastSync: s, theme: 't' + s, fieldUpdatedAt: { ...(r.fieldUpdatedAt || {}), theme: s } }; },
    ];
    return { reps, rnd, ops };
}
test('M5 3000 seeds with due edits, refunds, sweeps: associativity, commutativity, idempotence, absorb', () => {
    for (let seed = 1; seed <= 3000; seed++) {
        const { reps, rnd, ops } = sim(seed, 3);
        for (let s = 0; s < 14; s++) { const i = Math.floor(rnd() * 3); reps[i] = ops[Math.floor(rnd() * ops.length)](reps[i]); }
        const [a, b, c] = reps;
        const mn = J(2026, 11, 20);
        const m = (x, y) => mg(x, y, mn);
        const l = m(m(a, b), c), r = m(a, m(b, c)), o = m(m(a, c), b);
        assert.strictEqual(H(l), H(r), 'assoc seed ' + seed);
        assert.strictEqual(H(l), H(o), 'order seed ' + seed);
        assert.strictEqual(H(m(a, b)), H(m(b, a)), 'comm seed ' + seed);
        assert.strictEqual(H(m(l, a)), H(l), 'absorb seed ' + seed);
        assert.strictEqual(H(m(l, l)), H(l), 'idem seed ' + seed);
    }
});

test('L1 applyRemoteSafe returns local unchanged on abort, merged otherwise', () => {
    const local = base({ lastSync: 1, tasks: [{ id: 'a', title: 'a' }] });
    assert.strictEqual(sync.applyRemoteSafe(local, base({ pointsHistory: 'bad' })), local);
    assert.ok(!sync.isMergeAborted(sync.applyRemoteSafe(local, base({ lastSync: 2 }))));
    assert.strictEqual(sync.applyRemoteSafe(local, null), local);
});

test('L2 survivor of !local / !remote is normalised (REST arrays decoded, id-less tasks get ids, corrupt aborts)', () => {
    const rest = { arrayValue: { values: [{ mapValue: { fields: { id: { stringValue: 'q' } } } }] } };
    assert.strictEqual(sync.mergeUserData(null, base({ tasks: rest }), undefined, { now: NOW }).tasks[0].id, 'q');
    assert.strictEqual(sync.mergeUserData(base({ tasks: [{ title: 'x' }] }), null, undefined, { now: NOW }).tasks[0].id.startsWith('tx_'), true);
    assert.strictEqual(sync.mergeUserData(null, base({ tasks: 5 }), undefined, { now: NOW }).aborted, true);
});

test('L3 refund/penalty id sets are reusable (opts.ids) and updated', () => {
    const ids = new Set();
    const rows = sync.penaltyRowsFor(hw(), DUE + 30 * 3600000, [], [], { now: DUE + 30 * 3600000, ids });
    assert.strictEqual(rows.length, 2);
    assert.ok(ids.has(rows[0].id) && ids.has(rows[1].id));
    assert.deepStrictEqual(sync.penaltyRowsFor(hw(), DUE + 30 * 3600000, rows, [], { now: DUE + 30 * 3600000, ids }), []);
});

test('L4 capped far-future stamps tie deterministically (associative)', () => {
    const mk = (v, ls) => base({ lastSync: ls, theme: v, fieldUpdatedAt: { theme: NOW + 9e9 } });
    const a = mk('a', 1), b = mk('b', 2), c = mk('c', 3);
    assert.strictEqual(H(mg(mg(a, b), c)), H(mg(a, mg(b, c))));
    assert.strictEqual(H(mg(mg(a, c), b)), H(mg(mg(b, a), c)));
});

test('L5 catchUp flag does not flap: merge(merge(x,y),x) == merge(x,y)', () => {
    const x = { id: `ph_pen1_t1_${DUE}`, taskId: 't1', points: -1, date: iso(J(2026, 11, 15, 12)), catchUp: true, dueMs: DUE };
    const y = { ...x, date: iso(J(2026, 11, 15, 13)), catchUp: true };
    const z = { ...x, date: iso(DUE) }; delete z.catchUp;
    for (const [p, q] of [[x, y], [x, z], [y, z]]) {
        const xy = sync.mergePointsHistory([p], [q]);
        assert.strictEqual(H(sync.mergePointsHistory(xy, [p])), H(xy));
        assert.strictEqual(H(sync.mergePointsHistory(xy, [q])), H(xy));
        assert.strictEqual(H(sync.mergePointsHistory([q], [p])), H(xy));
    }
});

test('L6 autoPenaltyApplied monotone true on re-merge of an old snapshot; explicit newer clear wins', () => {
    const old = base({ lastSync: 1, tasks: [hw({ autoPenaltyApplied: true, updatedAt: 5 })] });
    const nu = base({ lastSync: 2, tasks: [hw({ autoPenaltyApplied: false, updatedAt: 5 })] });
    for (const m of [mg(old, nu), mg(nu, old)]) assert.strictEqual(m.tasks[0].autoPenaltyApplied, true);
    // (M7: monotone OR - a newer explicit clear no longer wins; see fixes3)
});

test('L7 weeklyPoints re-derived to 0 when deleted-task rows empty the ledger', () => {
    const row = { id: 'ph_t9', taskId: 't9', points: 2, date: iso(NOW - 3600000) };
    const a = base({ lastSync: 1, deletedTaskIds: ['t9'], weeklyPoints: 2, totalPoints: 2, pointsHistory: [row] });
    const b = base({ lastSync: 2, weeklyPoints: 2, totalPoints: 2, pointsHistory: [row], tasks: [{ id: 't9', title: 'x' }] });
    const m = mg(a, b);
    assert.strictEqual(m.pointsHistory.length, 0);
    assert.strictEqual(m.weeklyPoints, 0);
    assert.strictEqual(m.totalPoints, 0);
});
