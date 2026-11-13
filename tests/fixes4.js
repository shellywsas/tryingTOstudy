// Round 3: S1 no streak derivation in merge, S2 no heal minting in merge, S3 Jerusalem Saturday helpers, S4 perf.
const assert = require('assert');
const sync = require('../js/sync-helpers.js');
const helpers = require('../js/helpers.js');
const { test, mulberry32 } = require('./harness.js');
const J = sync.jerusalemMs;
const iso = (ms) => new Date(ms).toISOString();
const base = (o = {}) => ({ username: 'u', name: 'u', tasks: [], pointsHistory: [], streakHistory: [], exams: [], badges: [],
    deletedTaskIds: [], deletedExamIds: [], taskStreak: 0, longestStreak: 0, lastSync: 0, ...o });
const mn = J(2026, 11, 20);
const mg = (a, b) => sync.mergeUserData(a, b, undefined, { now: mn });
const H = (u) => sync.contentHash(u);

function sim(seed) {
    const rnd = mulberry32(seed); let tick = 1000, nid = 0;
    const reps = Array.from({ length: 3 }, () => base());
    const at = () => J(2026, 11, 1, 8) + (++tick) * 3600000;
    const ops = [
        (r) => { const id = 't' + (nid++); const s = ++tick; return { ...r, lastSync: s, tasks: [{ id, title: 'n' + s, dueDate: '2030-01-01', updatedAt: s }, ...r.tasks] }; },
        (r) => { const open = r.tasks.filter(t => !t.completed); if (!open.length) return r; const t = open[Math.floor(rnd() * open.length)]; const s = ++tick; const c = at();
            const keepRow = rnd() > 0.2; // 20% of completions never reach the ledger on this replica
            const streak = (r.taskStreak || 0) + 1;
            return { ...r, lastSync: s, taskStreak: streak, longestStreak: Math.max(streak, r.longestStreak), currentStreakStart: rnd() < 0.5 ? null : r.currentStreakStart || iso(c),
                tasks: r.tasks.map(x => x.id === t.id ? { ...x, completed: true, completedAt: iso(c), pointsEarned: 1, updatedAt: s } : x),
                pointsHistory: keepRow ? [{ id: 'ph_' + t.id, taskId: t.id, points: 1, date: iso(c) }, ...r.pointsHistory] : r.pointsHistory }; },
        (r) => { if (!(r.taskStreak > 0)) return r; const s = ++tick; const e = iso(at());
            return { ...r, lastSync: s, taskStreak: 0, currentStreakStart: null, streakHistory: [...r.streakHistory, { id: 'sh_' + s, startDate: rnd() < 0.5 ? null : e, endDate: e, length: r.taskStreak }] }; },
        (r) => { if (!r.tasks.length) return r; const t = r.tasks[Math.floor(rnd() * r.tasks.length)]; const s = ++tick; return { ...r, lastSync: s, tasks: r.tasks.filter(x => x.id !== t.id), deletedTaskIds: [...r.deletedTaskIds, t.id] }; },
    ];
    return { reps, rnd, ops };
}
test('S1/S2 3000 seeds: streak starts + healed rows are not minted in merge -> associative, commutative, idempotent, absorbing', () => {
    for (let seed = 1; seed <= 3000; seed++) {
        const { reps, rnd, ops } = sim(seed);
        const snaps = [];
        for (let s = 0; s < 12; s++) { const i = Math.floor(rnd() * 3); reps[i] = ops[Math.floor(rnd() * ops.length)](reps[i]); snaps.push(reps[i]); }
        const [a, b, c] = reps; const l = mg(mg(a, b), c);
        assert.strictEqual(H(l), H(mg(a, mg(b, c))), 'assoc ' + seed);
        assert.strictEqual(H(l), H(mg(mg(a, c), b)), 'order ' + seed);
        assert.strictEqual(H(mg(a, b)), H(mg(b, a)), 'comm ' + seed);
        assert.strictEqual(H(mg(l, l)), H(l), 'idem ' + seed);
        assert.strictEqual(H(mg(l, a)), H(l), 'absorb ' + seed);
        assert.ok(!l.pointsHistory.some(r => String(r.id).startsWith('ph_healed_')), 'merge must not mint healed rows');
    }
});

test('S1/S2 single-device heal still mints ph_healed_ rows and derives streak start; merge does neither', () => {
    const c = iso(J(2026, 11, 10, 9));
    const u = base({ taskStreak: 1, currentStreakStart: null, lastSync: 5, pointsHistory: [{ id: 'k', taskId: 'z', points: 1, date: c }],
        tasks: [{ id: 't1', title: 'x', dueDate: '2030-01-01', completed: true, completedAt: c, pointsEarned: 2 }] });
    const h = sync.healCompletedFromHistory(u, mn);
    assert.ok(h.pointsHistory.some(r => r.id === 'ph_healed_t1'));
    assert.strictEqual(h.currentStreakStart, c);
    const m = mg(u, { ...u, lastSync: 6 });
    assert.ok(!m.pointsHistory.some(r => r.id === 'ph_healed_t1'));
    assert.ok(!sync.isValidStart(m.currentStreakStart));
    const r = sync.repairStreakDates(m); // load path derives later
    assert.ok(sync.isValidStart(r.currentStreakStart));
});

test('S3 getLastSaturday22PM / getNextSaturday22PM are Jerusalem based and agree with getWindowStart (any host TZ)', () => {
    for (const [now, last, next] of [
        // live-repo week boundary: Sunday 00:00 Asia/Jerusalem (all of Saturday belongs to the ending week)
        [J(2026, 11, 13, 12), J(2026, 11, 8, 0), J(2026, 11, 15, 0)],
        [J(2026, 11, 14, 23, 59), J(2026, 11, 8, 0), J(2026, 11, 15, 0)],
        [J(2026, 11, 15, 0), J(2026, 11, 15, 0), J(2026, 11, 22, 0)],
        [J(2026, 10, 25, 12), J(2026, 10, 25, 0), J(2026, 11, 1, 0)],
        [J(2026, 3, 27, 23), J(2026, 3, 22, 0), J(2026, 3, 29, 0)],
    ]) {
        assert.strictEqual(sync.getLastSaturday22PM(now), last);
        assert.strictEqual(sync.getWindowStart(now), last);
        assert.strictEqual(helpers.getLastSaturday22PM(now), last);
        assert.strictEqual(helpers.getNextSaturday22PM(now), next);
        assert.strictEqual(sync.nextWindowStart(now), next);
        assert.strictEqual(helpers.getNextSaturdayMidnight(now), next);
        assert.strictEqual(helpers.getCurrentWeekStart(now), last);
        assert.strictEqual(helpers.getNextWeekReset(now), next);
    }
});

test('S4 first sweep of 3000 tasks with a large ledger is fast (< 2 s guard)', () => {
    const now = J(2026, 11, 13, 12);
    const tasks = Array.from({ length: 3000 }, (_, i) => ({ id: 'k' + i, title: 't' + i, subjectId: 's', dueDate: '2026-11-10', dueTime: '10:00' }));
    const seen = Array.from({ length: 3000 }, (_, i) => ({ id: 'ph_x' + i, taskId: 'o' + i, points: 1, date: iso(now - 1e9) }));
    const t0 = Date.now(); let n = 0;
    for (const t of tasks) { const rows = sync.penaltyRowsFor(t, now, seen, [], { now }); n += rows.length; seen.push(...rows); }
    const dt = Date.now() - t0;
    assert.strictEqual(n, 6000);
    for (const t of tasks) assert.strictEqual(sync.penaltyRowsFor(t, now, seen, [], { now }).length, 0);
    const rf = sync.refundRowsFor('k5', seen, iso(now));
    assert.strictEqual(rf.length, 2);
    assert.ok(dt < 2000, 'sweep took ' + dt + ' ms');
});

test('S6 same-id ph_pen rows with equal points/date but different cosmetic fields: merge is associative/commutative', () => {
    const baseRow = { id: 'ph_pen2_t_1', taskId: 't', points: -1, dueMs: 1, date: '2026-11-11T09:46:47.753Z' };
    const vs = [{ taskTitle: 'A', details: 'x' }, { taskTitle: 'B' }, { subjectName: 'm', details: 'y' }, { taskTitle: 'A', subjectName: 'n' }, { catchUp: true }];
    const m = (x, y) => sync.mergePointsHistory([x], [y])[0];
    const h = (x) => JSON.stringify(x, Object.keys(x).sort());
    for (const p of vs) for (const q of vs) for (const r of vs) {
        const a = { ...baseRow, ...p }, b = { ...baseRow, ...q }, c = { ...baseRow, ...r };
        assert.strictEqual(h(m(m(a, b), c)), h(m(a, m(b, c))));
        assert.strictEqual(h(m(a, b)), h(m(b, a)));
        assert.strictEqual(h(m(m(a, b), a)), h(m(a, b)));
    }
});

test('S7 stale snapshot never flips autoPenaltyApplied back on after a due edit refunded the penalty', () => {
    const now = J(2026, 11, 13, 12);
    const task = { id: 't', title: 'x', dueDate: '2026-11-12', dueTime: '08:00:00', completed: false, updatedAt: now - 9e8 };
    const pen = sync.penaltyRowsFor(task, now, [], [], { now });
    const B = base({ lastSync: now - 5e8, tasks: [{ ...task, autoPenaltyApplied: true }], pointsHistory: pen });
    const nd = new Date(now + 3 * 864e5).toISOString();
    let A = { ...B, tasks: [{ ...task, dueDate: nd.slice(0, 10), dueTime: '12:00:00', updatedAt: now + 1000, autoPenaltyApplied: true }] };
    A = sync.restoreOnDueEdit(A, 't', sync.getDueMs(task), sync.getDueMs(A.tasks[0]), now + 1000);
    A.lastSync = now + 1000;
    assert.strictEqual(A.tasks[0].autoPenaltyApplied, false);
    for (const m of [sync.mergeUserData(A, B, undefined, { now: now + 2000 }), sync.mergeUserData(B, A, undefined, { now: now + 2000 })]) {
        assert.strictEqual(m.tasks[0].autoPenaltyApplied, false);
        assert.strictEqual(m.tasks[0].dueDate, nd.slice(0, 10));
        assert.strictEqual(sync.sumLedger(m.pointsHistory, {}), 0);
    }
});

test('S8 null-start current streak rebuilt after an old break is kept (her real shape)', () => {
    const doneAt = J(2026, 11, 12, 23, 6);
    const doc = base({ lastSync: J(2026, 11, 13), taskStreak: 1, longestStreak: 57, currentStreakStart: null,
        tasks: [{ id: 'n', title: 'x', dueDate: '2030-01-01', completed: true, completedAt: iso(doneAt), pointsEarned: 1, updatedAt: 5 }],
        pointsHistory: [{ id: 'ph_n', taskId: 'n', points: 1, date: iso(doneAt) }],
        streakHistory: [{ id: 'sh_1', startDate: null, endDate: '2026-11-12T20:00:00.000Z', length: 57, brokenByTaskId: 'late' }] });
    for (const m of [mg(doc, { ...doc, lastSync: doc.lastSync + 1 }), mg(doc, base({ lastSync: 1 }))]) assert.strictEqual(m.taskStreak, 1);
    // a break newer than the last counted completion still kills a stale streak
    const stale = { ...doc, streakHistory: [{ id: 'sh_2', startDate: null, endDate: iso(doneAt + 3600000), length: 57 }] };
    assert.strictEqual(mg(stale, { ...stale, lastSync: stale.lastSync + 1 }).taskStreak, 0);
});

test('A getWindowStart(NaN/garbage) does not throw', () => {
    for (const v of [NaN, 'garbage', {}, undefined, null]) assert.ok(Number.isFinite(sync.getWindowStart(v)));
    assert.ok(Number.isFinite(sync.nextWindowStart('x')));
});

test('B legacy rows without taskId (ph_auto_<task>, ph_auto_<task>_ts, ph_pen1_<task>) are found by the index', () => {
    const t = { id: 't_77', title: 'x', dueDate: '2026-11-12', dueTime: '22:00' };
    const due = J(2026, 11, 12, 22);
    const now = due + 30 * 3600000;
    for (const legacy of [{ id: 'ph_auto_t_77', points: -2 }, { id: 'ph_auto_t_77_1794000000000', points: -2 }]) {
        assert.deepStrictEqual(sync.penaltyRowsFor(t, now, [legacy], [], { now }), [], legacy.id);
        assert.deepStrictEqual(sync.refundRowsFor('t_77', [{ ...legacy, date: iso(due) }], iso(now)).map(r => r.id), ['ph_refund_' + legacy.id]);
    }
    const pen1 = [{ id: 'ph_pen1_t_77', points: -1, date: iso(due) }];
    assert.deepStrictEqual(sync.penaltyRowsFor(t, due + 600000, pen1, [], { now: due + 600000 }), []);
    assert.deepStrictEqual(sync.penaltyRowsFor(t, now, pen1, [], { now }).map(r => r.id), [`ph_pen2_t_77_${due}`]);
});

test('C optional ledger key winner is independent of merge grouping (all 6 orders)', () => {
    const row = { id: 'ph_x', taskId: 't', points: 1, date: '2026-11-10T10:00:00.000Z' };
    const a = { ...row, updatedAt: 1, note: 'A' }, b = { ...row, updatedAt: 3 }, c = { ...row, updatedAt: 2, note: 'C' };
    const m = (p, q) => sync.mergePointsHistory([p], [q])[0];
    const h = (x) => JSON.stringify(x, Object.keys(x).sort());
    const rs = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const res = new Set();
    for (const [p, q, r] of rs) { res.add(h(m(m(p, q), r))); res.add(h(m(p, m(q, r)))); }
    assert.strictEqual(res.size, 1, [...res].join(' | '));
    assert.strictEqual(JSON.parse([...res][0]).note, 'C');
    assert.strictEqual(JSON.parse([...res][0]).updatedAt, 3);
});
