// Fix-pass tests (review defects 1-19). Each guards a named bug.
const assert = require('assert');
const sync = require('../js/sync-helpers.js');
const { test, mulberry32 } = require('./harness.js');
const L = (y, mo, d, h = 0, mi = 0, s = 0) => sync.jerusalemMs(y, mo, d, h, mi, s); // Asia/Jerusalem wall time: host-TZ independent
const iso = (ms) => new Date(ms).toISOString();
const NOW = L(2026, 11, 13, 12, 0, 0);
const hw = (o = {}) => ({ id: 't1', title: 'ש', subjectId: 's1', dueDate: '2026-11-12', dueTime: '22:00', ...o });
const base = (o = {}) => ({ username: 'u', name: 'u', tasks: [], pointsHistory: [], streakHistory: [], exams: [], badges: [],
    deletedTaskIds: [], deletedExamIds: [], taskStreak: 0, longestStreak: 0, lastSync: 0, ...o });
const mg = (a, b, now = NOW) => sync.mergeUserData(a, b, undefined, { now });
const H = (u) => sync.contentHash(u);
const DUE = L(2026, 11, 12, 22);

test('#1 refund then re-late (new due) is charged again; legacy unsuffixed id recognised', () => {
    const t = hw();
    const r1 = sync.penaltyRowsFor(t, DUE + 600000, [], [], { now: DUE + 600000 });
    assert.strictEqual(r1[0].id, `ph_pen1_t1_${DUE}`);
    assert.strictEqual(r1[0].dueMs, DUE);
    const refund = sync.refundRowsFor('t1', r1, iso(DUE + 700000));
    const ledger = [...r1, ...refund];
    const newDue = L(2026, 11, 14, 22);
    const t2 = hw({ dueDate: '2026-11-14' });
    const r2 = sync.penaltyRowsFor(t2, newDue + 600000, ledger, [], { now: newDue + 600000 });
    assert.deepStrictEqual(r2.map(r => r.id), [`ph_pen1_t1_${newDue}`]);
    // legacy unsuffixed row for the same due blocks; refunded legacy does not
    const legacy = [{ id: 'ph_pen1_t1', taskId: 't1', points: -1, date: iso(DUE) }];
    assert.deepStrictEqual(sync.penaltyRowsFor(t, DUE + 600000, legacy, [], { now: DUE + 600000 }), []);
    const legacyRef = [...legacy, { id: 'ph_refund_ph_pen1_t1', taskId: 't1', points: 1, date: iso(DUE + 5) }];
    assert.strictEqual(sync.penaltyRowsFor(t, DUE + 600000, legacyRef, [], { now: DUE + 600000 }).length, 1);
});

test('#2 legacy ph_auto_<taskId>_<ts> without taskId field blocks double charge', () => {
    const legacy = [{ id: 'ph_auto_t1_1794000000000', points: -2, date: iso(DUE) }];
    assert.deepStrictEqual(sync.penaltyRowsFor(hw(), DUE + 30 * 3600000, legacy, [], { now: DUE + 30 * 3600000 }), []);
});

test('#3 opening balance: minted once, deterministic, never negative, permanent', () => {
    const u = { tasks: [], totalPoints: 100, weeklyPoints: 0, pointsHistory: [{ id: 'p1', taskId: 'a', points: 4, date: iso(L(2026, 11, 9)) }] };
    const h = sync.healCompletedFromHistory(u, NOW);
    const ob = h.pointsHistory.filter(r => r.id === 'ph_opening_balance');
    assert.strictEqual(ob.length, 1);
    assert.strictEqual(ob[0].points, 96);
    assert.ok(new Date(ob[0].date).getTime() < sync.getWindowStart(NOW));
    assert.strictEqual(h.totalPoints, 100);
    assert.strictEqual(h.weeklyPoints, 4);
    assert.strictEqual(sync.healCompletedFromHistory(h, NOW).pointsHistory.length, h.pointsHistory.length);
    const low = sync.healCompletedFromHistory({ tasks: [], totalPoints: 1, pointsHistory: u.pointsHistory }, NOW);
    assert.ok(!low.pointsHistory.some(r => r.id === 'ph_opening_balance'));
    assert.strictEqual(low.totalPoints, 4);
    // two devices mint the same row; merge keeps one
    const m = mg(sync.healCompletedFromHistory(u, NOW), sync.healCompletedFromHistory({ ...u, lastSync: 3 }, NOW));
    assert.strictEqual(m.pointsHistory.filter(r => r.id === 'ph_opening_balance').length, 1);
    assert.strictEqual(m.totalPoints, 100);
});

test('#4 same-id ledger conflicts: penalty keeps negative, refund keeps positive, id-less rows survive', () => {
    const neg = { id: 'ph_pen1_t1_5', taskId: 't1', points: -1, date: iso(DUE) };
    const pos = { ...neg, points: 1 };
    for (const [a, b] of [[neg, pos], [pos, neg]]) assert.strictEqual(sync.mergePointsHistory([a], [b])[0].points, -1);
    const rf = { id: 'ph_refund_x', points: 1, date: iso(DUE) };
    for (const [a, b] of [[rf, { ...rf, points: -1 }], [{ ...rf, points: -1 }, rf]]) assert.strictEqual(sync.mergePointsHistory([a], [b])[0].points, 1);
    const manual = [{ points: 5 }, { points: 5, details: 'x' }, { points: 5 }];
    const m = sync.mergePointsHistory(manual, []);
    assert.strictEqual(m.length, 2); // identical content collapses, distinct kept
    assert.strictEqual(sync.sumLedger(m, {}), 10);
    const x = { id: 'ph_z', points: 1, updatedAt: 5 }, y = { id: 'ph_z', points: 2, updatedAt: 9 };
    assert.strictEqual(sync.mergePointsHistory([x], [y])[0].points, 2);
    assert.strictEqual(sync.mergePointsHistory([y], [x])[0].points, 2);
});

test('#5 completed task: no step2 minted; merged pen2 voided by deterministic refund, order independent', () => {
    const doneAt = DUE + 2 * 3600000;
    const t = hw({ completed: true, completedAt: iso(doneAt) });
    const rows = sync.penaltyRowsFor(t, DUE + 30 * 3600000, [], [], { now: DUE + 30 * 3600000 });
    assert.deepStrictEqual(rows.map(r => r.id), [`ph_pen1_t1_${DUE}`]);
    const pen1 = rows[0];
    const pen2 = { id: `ph_pen2_t1_${DUE}`, taskId: 't1', points: -1, date: iso(DUE + 86400000), dueMs: DUE };
    const A = base({ lastSync: 5, tasks: [{ ...t, updatedAt: 5, autoPenaltyApplied: true }], pointsHistory: [pen1] });
    const B = base({ lastSync: 6, tasks: [hw({ updatedAt: 1 })], pointsHistory: [pen1, pen2] });
    const n = DUE + 40 * 3600000;
    const ab = mg(A, B, n), ba = mg(B, A, n);
    assert.strictEqual(H(ab), H(ba));
    assert.ok(ab.pointsHistory.some(r => r.id === 'ph_refund_' + pen2.id));
    assert.strictEqual(sync.sumLedger(ab.pointsHistory, {}), -1);
    assert.strictEqual(H(mg(ab, B, n)), H(ab));
});

test('#6 catch-up penalty dated into current week, deterministic merge (earliest date)', () => {
    const t = hw();
    const n = L(2026, 11, 15, 12); // due fell in the closed window
    const rows = sync.penaltyRowsFor(t, n, [], [], { now: n });
    assert.strictEqual(rows.length, 2);
    for (const r of rows) assert.ok(new Date(r.date).getTime() >= sync.getWindowStart(n), r.id);
    assert.strictEqual(rows[0].dueMs, DUE);
    assert.strictEqual(sync.sumLedger(rows, { from: sync.getWindowStart(n) }), -2);
    const early = { ...rows[0], date: iso(DUE) };
    assert.strictEqual(sync.mergePointsHistory([rows[0]], [early])[0].date, iso(DUE));
    assert.strictEqual(sync.mergePointsHistory([early], [rows[0]])[0].date, iso(DUE));
});

test('#7 Firestore Timestamp / numeric-string / number dates in the ledger', () => {
    const from = L(2026, 11, 8);
    const ms = L(2026, 11, 10);
    const hist = [
        { id: 'a', points: 1, date: { seconds: Math.floor(ms / 1000), nanoseconds: 0 } },
        { id: 'b', points: 2, date: { toMillis: () => ms } },
        { id: 'c', points: 4, date: String(ms) },
        { id: 'd', points: 8, date: ms },
        { id: 'e', points: 16, date: iso(ms) },
        { id: 'f', points: 32, date: { _seconds: Math.floor(ms / 1000) } },
    ];
    assert.strictEqual(sync.sumLedger(hist, { from }), 63);
});

test('#8 deriveStreakStart counts only streak-advancing tasks (no lesson logs / given up / late)', () => {
    const mk = (id, c, o = {}) => ({ id, completed: true, completedAt: iso(c), dueDate: '2030-01-01', ...o });
    const base0 = L(2026, 10, 1, 10);
    const tasks = [mk('a', base0), mk('lesson', base0 + 1e6, { isLessonLog: true }), mk('b', base0 + 2e6),
        mk('gu', base0 + 3e6, { givenUp: true }), mk('late', base0 + 4e6, { dueDate: '2026-01-01' }),
        mk('p', base0 + 5e6, { isPracticeSession: true }), mk('c', base0 + 6e6)];
    // streak 3 = c, p (exempt types advance), b
    assert.strictEqual(sync.deriveStreakStart(tasks, 3, Infinity), iso(base0 + 2e6));
    assert.strictEqual(sync.deriveStreakStart(tasks, 4, Infinity), iso(base0));
    assert.strictEqual(sync.deriveStreakStart(tasks, 5, Infinity), null);
});

test('#9 healing never inflates a restored streak on repeated merges', () => {
    const start = iso(L(2026, 11, 1, 10));
    const task = hw({ completed: true, completedAt: iso(DUE - 3600000), updatedAt: 9 });
    const A = base({ lastSync: 9, taskStreak: 4, longestStreak: 4, currentStreakStart: start, tasks: [task],
        pointsHistory: [{ id: 'ph_x', taskId: 't1', points: 2, date: iso(DUE - 3600000) }] });
    const B = base({ lastSync: 5, taskStreak: 0, tasks: [hw({ updatedAt: 1 })],
        streakHistory: [{ id: 'sh_1', startDate: start, endDate: iso(DUE), length: 3, brokenByTaskId: 't1' }] });
    let m = mg(A, B);
    assert.strictEqual(m.taskStreak, 4);
    for (let i = 0; i < 4; i++) { m = mg(m, B); assert.strictEqual(m.taskStreak, 4, 'iteration ' + i); m = mg(B, m); assert.strictEqual(m.taskStreak, 4); }
    // 57 -> 58 -> 115 reviewer scenario
    const A2 = { ...A, taskStreak: 58, longestStreak: 58 };
    const B2 = { ...B, streakHistory: [{ id: 'sh_2', startDate: start, endDate: iso(DUE), length: 57, brokenByTaskId: 't1' }] };
    let m2 = mg(A2, B2);
    for (let i = 0; i < 4; i++) { m2 = mg(m2, B2); assert.strictEqual(m2.taskStreak, 58); }
    // restoreOnDueEdit then merge with stale record
    const u = { tasks: [hw({ autoPenaltyApplied: true })], taskStreak: 1, longestStreak: 3, currentStreakStart: iso(L(2026, 11, 13)),
        pointsHistory: [], streakHistory: [{ id: 'sh_3', startDate: start, endDate: iso(DUE), length: 3, brokenByTaskId: 't1' }] };
    const r = sync.restoreOnDueEdit(u, 't1', '2026-11-12', new Date(NOW + 86400000), NOW);
    assert.strictEqual(r.taskStreak, 4); // disjoint streaks add up once
    // the due edit itself (restoreOnDueEdit only reverses penalties): the task is no longer overdue, so no live-repo overdue kill
    const r1 = { ...r, lastSync: 9, tasks: r.tasks.map((t) => ({ ...t, dueDate: '2026-11-14', updatedAt: 5 })) };
    const r2 = mg(r1, { ...base(), streakHistory: u.streakHistory, tasks: u.tasks, lastSync: 1 });
    assert.strictEqual(r2.taskStreak, 4);
});

function sim(seed, n, steps) {
    const rnd = mulberry32(seed); let tick = 1000, nid = 0;
    const reps = Array.from({ length: n }, () => base({ theme: 't0' }));
    const ops = [
        (r) => { const id = 't' + (nid++); const s = ++tick; return { ...r, tasks: [{ id, title: 'n' + s, dueDate: '2026-11-20', createdAt: s, updatedAt: s }, ...r.tasks], lastSync: s }; },
        (r) => { if (!r.tasks.length) return r; const k = Math.floor(rnd() * r.tasks.length); const s = ++tick; return { ...r, lastSync: s, tasks: r.tasks.map((t, j) => j === k && !t.completed ? { ...t, title: 'e' + s, updatedAt: s } : t) }; },
        (r) => { const open = r.tasks.filter(t => !t.completed); if (!open.length) return r; const t = open[Math.floor(rnd() * open.length)]; const s = ++tick; const at = iso(L(2026, 11, 10, 8) + s * 1000);
            return { ...r, lastSync: s, tasks: r.tasks.map(x => x.id === t.id ? { ...x, completed: true, completedAt: at, pointsEarned: 1, updatedAt: s } : x), pointsHistory: [{ id: 'ph_' + t.id, taskId: t.id, points: 1, date: at }, ...r.pointsHistory] }; },
        (r) => { if (!r.tasks.length) return r; const t = r.tasks[Math.floor(rnd() * r.tasks.length)]; const s = ++tick; return { ...r, lastSync: s, tasks: r.tasks.filter(x => x.id !== t.id), deletedTaskIds: [...r.deletedTaskIds, t.id] }; },
        (r) => { const s = ++tick; return { ...r, lastSync: s, theme: 't' + s, fieldUpdatedAt: { ...(r.fieldUpdatedAt || {}), theme: s } }; },
        (r) => { if (!r.tasks.length) return r; const t = r.tasks.find(x => x.completed); if (!t) return r; const s = ++tick; // un-complete
            return { ...r, lastSync: s, tasks: r.tasks.map(x => x.id === t.id ? (({ completedAt, ...rest }) => ({ ...rest, completed: false, uncompletedAt: s + 1e12 * 0 + L(2026, 11, 11), updatedAt: s }))(x) : x),
                pointsHistory: r.pointsHistory.map(p => p.taskId === t.id && p.points > 0 ? { ...p, canceled: true } : p) }; },
    ];
    return { reps, rnd, ops };
}
test('#10/#11 3000 seeds: associativity, commutativity, idempotence, deletes, scalar ties', () => {
    for (let seed = 1; seed <= 3000; seed++) {
        const { reps, rnd, ops } = sim(seed, 3);
        for (let s = 0; s < 9; s++) { const i = Math.floor(rnd() * 3); reps[i] = ops[Math.floor(rnd() * ops.length)](reps[i]); }
        const [a, b, c] = reps;
        const l = mg(mg(a, b), c), r = mg(a, mg(b, c)), o = mg(mg(a, c), b);
        assert.strictEqual(H(l), H(r), 'assoc seed ' + seed);
        assert.strictEqual(H(l), H(o), 'order seed ' + seed);
        assert.strictEqual(H(mg(a, b)), H(mg(b, a)), 'comm seed ' + seed);
        assert.strictEqual(H(mg(l, a)), H(l), 'idem seed ' + seed);
        assert.strictEqual(H(mg(l, l)), H(l), 'idem2 seed ' + seed);
        assert.strictEqual(l.lastSync, Math.max(a.lastSync, b.lastSync, c.lastSync));
        if (process.env.SIMSTAT) { const g = global.__s = global.__s || { t: 0, d: 0, u: 0, p: 0 }; if (l.tasks.length) g.t++; if (l.deletedTaskIds.length) g.d++; if (l.tasks.some(x => x.uncompletedAt)) g.u++; if (l.pointsHistory.length) g.p++; if (seed === 3000) console.log(JSON.stringify(g)); }
    }
});

test('#11 equal lastSync: scalar tie-break per field, merge(merge(x,y),x) == merge(x,y)', () => {
    const x = base({ lastSync: 5, theme: 'dark', lang: 'he' }), y = base({ lastSync: 5, theme: 'light', lang: 'en' });
    const m = mg(x, y);
    assert.strictEqual(H(mg(y, x)), H(m));
    assert.strictEqual(H(mg(m, x)), H(m));
    assert.strictEqual(H(mg(m, y)), H(m));
});

test('#12 empty detection: scalars/legacy totals count; empty side forced to lose but merge still runs', () => {
    assert.strictEqual(sync.isEmptyLocal({ tasks: [], theme: 'dark' }), false);
    assert.strictEqual(sync.isEmptyLocal({ tasks: [], totalPoints: 5 }), false);
    assert.strictEqual(sync.isEmptyLocal({ tasks: [], theme: '', lastSync: 9e12 }), true);
    const cloud = base({ lastSync: 100, theme: 'dark', taskStreak: 3, currentStreakStart: null, tasks: [{ id: 'a', title: 'x', completed: true, completedAt: iso(L(2026, 11, 1)), updatedAt: 3 }] });
    const phone = { username: 'u', tasks: [], theme: '', lastSync: 9e12 };
    const m = mg(phone, cloud);
    assert.strictEqual(m.theme, 'dark');
    assert.ok(sync.isValidStart(m.currentStreakStart) || m.currentStreakStart === null);
    assert.strictEqual(H(mg(cloud, phone)), H(m));
    const settingsOnly = { username: 'u', theme: 'x', tasks: [], lastSync: 1 };
    const full = base({ lastSync: 0, tasks: [{ id: 'q', title: 'keep', updatedAt: 1 }] });
    assert.strictEqual(mg(settingsOnly, full).tasks.length, 1);
    assert.strictEqual(mg(full, settingsOnly).tasks.length, 1);
});

test('#13 unstamped null scalar never overwrites a real value', () => {
    const l = base({ lastSync: 1, goal: 'x' }), r = base({ lastSync: 9, goal: null });
    assert.strictEqual(mg(l, r).goal, 'x');
    assert.strictEqual(mg(r, l).goal, 'x');
    const stamped = base({ lastSync: 9, goal: null, fieldUpdatedAt: { goal: 50 } });
    assert.strictEqual(mg(l, stamped).goal, null); // explicit stamped clear wins
});

test('#14 field deleted by the winner stays deleted', () => {
    const a = base({ lastSync: 1, tasks: [{ id: 't', title: 'x', note: 'old', updatedAt: 5 }] });
    const b = base({ lastSync: 2, tasks: [{ id: 't', title: 'x', updatedAt: 9 }] });
    assert.ok(!('note' in mg(a, b).tasks[0]));
    assert.ok(!('note' in mg(b, a).tasks[0]));
});

test('#15 clock skew: stamps beyond the doc own lastSync+5min are clamped (data-only); no stamp-from-now fallback', () => {
    const a = base({ lastSync: NOW, theme: 'a', fieldUpdatedAt: { theme: NOW + 3 * 86400000 }, tasks: [{ id: 't', title: 'far', updatedAt: NOW + 5 * 86400000 }] });
    const b = base({ lastSync: NOW + 1000, theme: 'b', fieldUpdatedAt: { theme: NOW + 60000 }, tasks: [{ id: 't', title: 'near', updatedAt: NOW + 120000 }] });
    const m = mg(a, b);
    assert.ok(m.fieldUpdatedAt.theme <= NOW + 5 * 60000);
    assert.ok(m.tasks[0].updatedAt <= NOW + 5 * 60000);
    assert.strictEqual(H(mg(b, a)), H(m));
    const u = sync.healCompletedFromHistory({ tasks: [], taskStreak: 2, currentStreakStart: null, pointsHistory: [{ id: 'p', points: 1, date: iso(NOW) }] }, NOW);
    assert.strictEqual(u.currentStreakStart, null);
});

test('#16 non-array managed field: decode REST arrays, abort otherwise (no partial write)', () => {
    const rest = { arrayValue: { values: [{ mapValue: { fields: { id: { stringValue: 't1' }, title: { stringValue: 'x' }, n: { integerValue: '3' } } } }] } };
    const m = mg(base({ lastSync: 1 }), base({ lastSync: 2, tasks: rest }));
    assert.strictEqual(m.tasks[0].id, 't1');
    assert.strictEqual(m.tasks[0].n, 3);
    const local = base({ lastSync: 1, tasks: [{ id: 'a', title: 'a' }] });
    const bad = mg(local, base({ lastSync: 2, pointsHistory: 'oops' }));
    assert.strictEqual(bad.aborted, true);
    assert.strictEqual(sync.isMergeAborted(bad), true);
    assert.ok(bad.error);
    assert.strictEqual(sync.isMergeAborted(m), false);
    assert.strictEqual(sync.mergeUserData(base({ tasks: 5 }), local).aborted, true);
});

test('#17 contentHash canonicalises Dates/Timestamps, ignores server-only keys', () => {
    const d = new Date('2026-11-10T10:00:00.000Z');
    const h = H({ a: d });
    assert.strictEqual(H({ a: d.toISOString() }), h);
    assert.strictEqual(H({ a: { seconds: Math.floor(d / 1000), nanoseconds: 0 } }), h);
    assert.strictEqual(H({ a: { toMillis: () => d.getTime() } }), h);
    assert.strictEqual(H({ a: 1, updateTime: 'x', createTime: 'y' }), H({ a: 1 }));
    assert.ok(sync.HASH_IGNORE_KEYS.includes('lastSync'));
});

test('#18 un-complete: two uncompletes converge on max stamp; newer edit behind un-complete kept', () => {
    const done = base({ lastSync: 1, tasks: [{ id: 't', title: 'a', completed: true, completedAt: iso(L(2026, 11, 10)), updatedAt: 10 }] });
    const u1 = base({ lastSync: 2, tasks: [{ id: 't', title: 'a', completed: false, uncompletedAt: L(2026, 11, 11, 10), updatedAt: 20 }] });
    const u2 = base({ lastSync: 3, tasks: [{ id: 't', title: 'a2', completed: false, uncompletedAt: L(2026, 11, 11, 12), updatedAt: 30 }] });
    const m = mg(mg(u1, u2), done), m2 = mg(done, mg(u2, u1));
    assert.strictEqual(H(m), H(m2));
    assert.strictEqual(m.tasks[0].uncompletedAt, L(2026, 11, 11, 12));
    assert.strictEqual(m.tasks[0].completed, false);
    assert.strictEqual(m.tasks[0].title, 'a2');
    // un-complete (older) vs newer title edit on the done side: edit survives, still un-completed
    const edit = base({ lastSync: 4, tasks: [{ id: 't', title: 'edited later', completed: true, completedAt: iso(L(2026, 11, 10)), updatedAt: 99 }] });
    const un = base({ lastSync: 2, tasks: [{ id: 't', title: 'a', completed: false, uncompletedAt: L(2026, 11, 11), updatedAt: 20 }] });
    for (const r of [mg(un, edit), mg(edit, un)]) { assert.strictEqual(r.tasks[0].title, 'edited later'); assert.strictEqual(r.tasks[0].completed, false); }
});

test('#19 tasks without id kept with deterministic id; duplicate ids collapse by newer updatedAt', () => {
    const a = base({ lastSync: 1, tasks: [{ title: 'no id' }] });
    const b = base({ lastSync: 2, tasks: [{ title: 'no id' }, { id: 'd', title: 'old', updatedAt: 1 }, { id: 'd', title: 'new', updatedAt: 5 }] });
    const m = mg(a, b);
    assert.strictEqual(m.tasks.length, 2);
    assert.ok(m.tasks.every(t => t.id));
    assert.strictEqual(m.tasks.find(t => t.id === 'd').title, 'new');
    assert.strictEqual(H(mg(b, a)), H(m));
});

test('#10 ledger rows of deleted tasks dropped; healed rows never double a real row', () => {
    const a = base({ lastSync: 1, deletedTaskIds: ['t9'], pointsHistory: [{ id: 'ph_t9', taskId: 't9', points: 2, date: iso(NOW - 1e6) }] });
    const b = base({ lastSync: 2, tasks: [{ id: 't9', title: 'x', completed: true, completedAt: iso(NOW - 1e6) }], pointsHistory: [{ id: 'ph_t9', taskId: 't9', points: 2, date: iso(NOW - 1e6) }] });
    assert.strictEqual(mg(a, b).pointsHistory.length, 0);
    const t = { id: 't5', title: 'x', completed: true, completedAt: iso(NOW - 1e6), dueDate: '2030-01-01', pointsEarned: 2 };
    const x = sync.healCompletedFromHistory(base({ lastSync: 1, tasks: [t] }), NOW); // mints ph_healed_t5
    const y = base({ lastSync: 2, tasks: [t], pointsHistory: [{ id: 'ph_real', taskId: 't5', points: 2, date: iso(NOW - 1e6) }] });
    const m = mg(x, y);
    assert.strictEqual(sync.sumLedger(m.pointsHistory, {}), 2);
    assert.strictEqual(H(m), H(mg(y, x)));
});
