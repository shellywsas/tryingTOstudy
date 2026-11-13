const assert = require('assert');
const sync = require('../js/sync-helpers.js');
const helpers = require('../js/helpers.js');
const { test, mulberry32 } = require('./harness.js');

const L = (y, mo, d, h = 0, mi = 0, s = 0) => sync.jerusalemMs(y, mo, d, h, mi, s); // Asia/Jerusalem wall time: host-TZ independent
const iso = (ms) => new Date(ms).toISOString();
const NOW = L(2026, 11, 13, 12, 0, 0);

// ---------- 1. ledger / window / totals ----------
test('getWindowStart: single Sunday-00:00 window (live-repo boundary), DST-safe (bug: 4 differently built cutoffs)', () => {
    assert.strictEqual(sync.getWindowStart(L(2026, 10, 25, 12)), L(2026, 10, 25, 0)); // DST end day (Sunday)
    assert.strictEqual(sync.getWindowStart(L(2026, 10, 24, 23, 59)), L(2026, 10, 18, 0)); // Saturday night still the old week
    assert.strictEqual(sync.getWindowStart(L(2026, 10, 25, 0, 0)), L(2026, 10, 25, 0));
    assert.strictEqual(sync.getWindowStart(L(2026, 3, 29, 12)), L(2026, 3, 29, 0)); // Sunday of EU DST
});

test('sumLedger/deriveTotals: signed, canceled excluded, windowed (bug: positive-only headline vs signed list)', () => {
    const hist = [
        { id: 'a', points: 2, date: iso(L(2026, 11, 9, 10)) },
        { id: 'b', points: -1, date: iso(L(2026, 11, 10, 10)) },
        { id: 'c', points: -2, date: iso(L(2026, 11, 10, 11)), canceled: true },
        { id: 'd', points: 5, date: iso(L(2026, 11, 1, 10)) },
        { id: 'e', points: 1, date: 'garbage' },
    ];
    assert.strictEqual(sync.sumLedger(hist, {}), 7);
    assert.strictEqual(sync.sumLedger(hist, { from: sync.getWindowStart(NOW) }), 1);
    assert.deepStrictEqual(sync.deriveTotals({ pointsHistory: hist }, NOW), { weeklyPoints: 1, totalPoints: 7 });
    assert.strictEqual(sync.sumLedger(null, {}), 0);
});

test('mergeUserData derives totals from merged ledger, no Math.max (bug: list != headline)', () => {
    const a = { username: 'x', tasks: [], totalPoints: 500, weeklyPoints: 99, lastSync: 1,
        pointsHistory: [{ id: 'p1', taskId: 't1', points: 2, date: iso(L(2026, 11, 9, 9)) }] };
    const b = { username: 'x', tasks: [], totalPoints: 7, weeklyPoints: 3, lastSync: 2,
        pointsHistory: [{ id: 'p2', taskId: 't2', points: -1, date: iso(L(2026, 11, 10, 9)) }] };
    const m = sync.mergeUserData(a, b, undefined, { now: NOW });
    // two non-empty ledgers: the stale stored 500 is NOT minted into an opening row during a two-sided merge
    assert.strictEqual(m.totalPoints, 1);
    assert.strictEqual(m.pointsHistory.filter(r => r.id === 'ph_opening_balance').length, 0);
    assert.strictEqual(m.weeklyPoints, 1);
    assert.strictEqual(m.weeklyPoints, sync.sumLedger(m.pointsHistory, { from: sync.getWindowStart(NOW) }));
});

// ---------- 2. lateness ----------
const hw = (o = {}) => ({ id: 't1', title: 'שיעורי בית', subjectId: 's1', dueDate: '2026-11-12', dueTime: '22:00', ...o });

test('isExemptTask: lesson log, flexible, practice, exam prep (new), reward tasks', () => {
    for (const k of ['isLessonLog', 'isFlexibleExamSession', 'isPracticeSession', 'isExamPrep']) {
        assert.strictEqual(sync.isExemptTask(hw({ [k]: true })), true, k);
    }
    assert.strictEqual(sync.isExemptTask(hw({ rewardPoints: 3 })), true);
    assert.strictEqual(sync.isExemptTask(hw()), false);
    assert.strictEqual(sync.isExemptTask(null), false);
});

test('evaluateLateness boundaries: 5 min grace, step1, step2 at exactly 24h (bug: 4 divergent rules)', () => {
    const due = L(2026, 11, 12, 22);
    const ev = (ms) => sync.evaluateLateness(hw(), ms, null);
    assert.deepStrictEqual([ev(due - 1).late, ev(due - 1).step], [false, 0]);
    assert.deepStrictEqual([ev(due + 300000).late, ev(due + 300000).step], [false, 0]); // grace edge inclusive
    assert.deepStrictEqual([ev(due + 300001).late, ev(due + 300001).step], [true, 1]);
    assert.strictEqual(ev(due + 86400000 - 1).step, 1);
    assert.strictEqual(ev(due + 86400000).step, 2);
    assert.ok(Math.abs(ev(due + 36 * 3600000).hoursLate - 36) < 1e-9);
    // unsubmitted: uses now
    assert.strictEqual(sync.evaluateLateness(hw(), null, due + 86400000).step, 2);
    assert.strictEqual(sync.evaluateLateness(hw(), null, due - 5).late, false);
});

test('evaluateLateness: date-only due = 23:59:59 local; exempt/no-due never late', () => {
    const t = { id: 'x', dueDate: '2026-11-12' };
    const end = L(2026, 11, 12, 23, 59, 59);
    assert.strictEqual(sync.evaluateLateness(t, end + 300000, null).late, false);
    assert.strictEqual(sync.evaluateLateness(t, end + 300001, null).step, 1);
    assert.strictEqual(sync.evaluateLateness(hw({ isExamPrep: true }), L(2026, 12, 1), null).late, false);
    assert.strictEqual(sync.evaluateLateness({ id: 'n' }, L(2026, 12, 1), null).step, 0);
    assert.strictEqual(sync.evaluateLateness(hw({ dueDate: 'bad' }), L(2026, 12, 1), null).late, false);
});

test('evaluateLateness DST days: due 22:00 local, step2 is 24 real hours (Asia/Jerusalem 2026-03-27/29, 10-25)', () => {
    for (const [d, y, mo, dd] of [['2026-03-27', 2026, 3, 27], ['2026-03-29', 2026, 3, 29], ['2026-10-25', 2026, 10, 25], ['2026-10-24', 2026, 10, 24]]) {
        const due = L(y, mo, dd, 22);
        const t = hw({ dueDate: d });
        assert.strictEqual(sync.evaluateLateness(t, due, null).late, false, d);
        assert.strictEqual(sync.evaluateLateness(t, due + 86400000 - 1, null).step, 1, d);
        assert.strictEqual(sync.evaluateLateness(t, due + 86400000, null).step, 2, d);
    }
});

// ---------- 3. penalty rows ----------
test('penaltyRowsFor: ladder rows deterministic, idempotent, canceled ids block (bug: double charge)', () => {
    const due = L(2026, 11, 12, 22);
    const t = hw();
    assert.deepStrictEqual(sync.penaltyRowsFor(t, due - 10, []), []);
    let rows = sync.penaltyRowsFor(t, due + 600000, []);
    assert.deepStrictEqual(rows.map(r => r.id), [`ph_pen1_t1_${due}`]);
    assert.strictEqual(rows[0].points, -1);
    assert.strictEqual(rows[0].date, iso(due));
    assert.strictEqual(rows[0].taskId, 't1');
    assert.strictEqual(rows[0].taskTitle, 'שיעורי בית');
    assert.ok(/[֐-׿]/.test(rows[0].details));
    rows = sync.penaltyRowsFor(t, due + 86400000, []);
    assert.deepStrictEqual(rows.map(r => r.id), [`ph_pen1_t1_${due}`, `ph_pen2_t1_${due}`]);
    assert.strictEqual(rows[1].date, iso(due + 86400000));
    assert.deepStrictEqual(sync.penaltyRowsFor(t, due + 86400000, rows), []);
    assert.deepStrictEqual(sync.penaltyRowsFor(t, due + 86400000, [{ id: `ph_pen1_t1_${due}`, canceled: true, points: -1 }]).map(r => r.id), [`ph_pen2_t1_${due}`]);
    assert.deepStrictEqual(sync.penaltyRowsFor(hw({ isExamPrep: true }), due + 9e9, []), []);
});

test('penaltyRowsFor: late submit charges only the ladder; legacy ph_auto_ blocks (bug: late-after-auto-penalty)', () => {
    const due = L(2026, 11, 12, 22);
    assert.deepStrictEqual(sync.penaltyRowsFor(hw(), due + 2 * 3600000, []).map(r => r.id), [`ph_pen1_t1_${due}`]);
    assert.deepStrictEqual(sync.penaltyRowsFor(hw(), due + 30 * 3600000, []).map(r => r.id), [`ph_pen1_t1_${due}`, `ph_pen2_t1_${due}`]);
    const legacy = [{ id: 'ph_auto_t1_123', taskId: 't1', points: -2 }];
    assert.deepStrictEqual(sync.penaltyRowsFor(hw(), due + 30 * 3600000, legacy), []);
    // pen rows are not completion evidence
    assert.strictEqual(sync.taskLooksCompleted(hw(), [{ id: 'ph_pen1_t1', taskId: 't1', points: -1 }]), false);
});

// ---------- 4. healing never deletes penalties ----------
test('heal: penalty rows are never deleted; on-time completion adds explicit refund once (bug: healer deleted ph_auto)', () => {
    const due = L(2026, 11, 12, 22);
    const u = { username: 'x', subjects: [], taskStreak: 0, longestStreak: 0,
        tasks: [hw({ completed: true, completedAt: iso(due - 3600000), pointsEarned: 1, autoPenaltyApplied: true })],
        pointsHistory: [
            { id: 'ph_ok', taskId: 't1', points: 1, date: iso(due - 3600000) },
            { id: 'ph_pen1_t1', taskId: 't1', points: -1, date: iso(due) },
            { id: 'ph_auto_t1_9', taskId: 't1', points: -2, date: iso(due) },
        ] };
    const h = sync.healCompletedFromHistory(u, NOW);
    assert.ok(h.pointsHistory.some(r => r.id === 'ph_pen1_t1'));
    assert.ok(h.pointsHistory.some(r => r.id === 'ph_auto_t1_9'));
    const r1 = h.pointsHistory.find(r => r.id === 'ph_refund_ph_pen1_t1');
    const r2 = h.pointsHistory.find(r => r.id === 'ph_refund_ph_auto_t1_9');
    assert.strictEqual(r1.points, 1); assert.strictEqual(r2.points, 2);
    assert.strictEqual(sync.sumLedger(h.pointsHistory, {}), 1);
    assert.strictEqual(h.totalPoints, 1);
    const h2 = sync.healCompletedFromHistory(h, NOW);
    assert.strictEqual(sync.contentHash(h2), sync.contentHash(h)); // idempotent
    assert.strictEqual(h2.pointsHistory.length, h.pointsHistory.length);
});

test('restoreOnDueEdit: refunds by deterministic rows, keeps penalties, once; streak start restored (bug: deleted/duplicated refunds)', () => {
    const due = L(2026, 11, 12, 22);
    const u = { tasks: [hw({ autoPenaltyApplied: true })], taskStreak: 0, longestStreak: 57,
        pointsHistory: [{ id: 'ph_pen1_t1', taskId: 't1', points: -1, date: iso(due) }, { id: 'ph_pen2_t1', taskId: 't1', points: -1, date: iso(due + 86400000) }],
        streakHistory: [{ id: 'sh_1', startDate: null, endDate: iso(due), length: 3, brokenByTaskId: 't1' }] };
    u.tasks.push(...[1, 2, 3].map(i => ({ id: 'c' + i, completed: true, completedAt: iso(due - i * 86400000) })));
    const r = sync.restoreOnDueEdit(u, 't1', hw().dueDate, new Date(NOW + 86400000), NOW);
    assert.deepStrictEqual(r.pointsHistory.filter(x => x.id.startsWith('ph_refund_')).map(x => x.id).sort(), ['ph_refund_ph_pen1_t1', 'ph_refund_ph_pen2_t1']);
    assert.ok(r.pointsHistory.some(x => x.id === 'ph_pen1_t1'));
    assert.strictEqual(sync.sumLedger(r.pointsHistory, {}), 0);
    assert.strictEqual(r.taskStreak, 3);
    assert.ok(sync.isValidStart(r.currentStreakStart));
    const r2 = sync.restoreOnDueEdit(r, 't1', hw().dueDate, new Date(NOW + 86400000), NOW);
    assert.strictEqual(r2.pointsHistory.length, r.pointsHistory.length);
});

// ---------- 5. streak ----------
test('isValidStart / fmtDate (bug: 1970 shown for null startDate)', () => {
    for (const bad of [null, undefined, '', 0, NaN, 'x', '1970-01-01T00:00:00Z', '2019-12-31T00:00:00Z']) assert.strictEqual(sync.isValidStart(bad), false, String(bad));
    assert.strictEqual(sync.isValidStart('2026-11-12T23:06:00.000Z'), true);
    assert.strictEqual(sync.isValidStart(L(2026, 1, 1)), true);
    assert.strictEqual(helpers.fmtDate(null), 'לא ידוע');
    assert.strictEqual(helpers.fmtDate('garbage'), 'לא ידוע');
    assert.strictEqual(helpers.fmtDate(0), 'לא ידוע');
    assert.notStrictEqual(helpers.fmtDate('2026-11-12T10:00:00Z'), 'לא ידוע');
});

test('mergeStreakHistory: null/invalid never overwrite valid, missing dates sort safely', () => {
    const a = [{ id: 'sh_1', startDate: '2026-09-17T08:00:00.000Z', endDate: '2026-11-12T20:00:00.000Z', length: 57 }];
    const b = [{ id: 'sh_1', startDate: null, endDate: null, length: 57 }, { id: 'sh_0', startDate: null, endDate: undefined, length: 3 }];
    const ab = sync.mergeStreakHistory(a, b), ba = sync.mergeStreakHistory(b, a);
    assert.strictEqual(ab.find(r => r.id === 'sh_1').startDate, '2026-09-17T08:00:00.000Z');
    assert.strictEqual(ba.find(r => r.id === 'sh_1').endDate, '2026-11-12T20:00:00.000Z');
    assert.deepStrictEqual(ab.map(r => r.id), ba.map(r => r.id));
    assert.strictEqual(ab[0].id, 'sh_1');
});

function shelyFixture() {
    const tasks = [];
    for (let i = 0; i < 78; i++) {
        const c = L(2026, 9, 7, 8) + i * 17 * 3600000;
        tasks.push({ id: 'h' + i, title: 'w' + i, dueDate: '2026-12-01', completed: true, completedAt: iso(c), pointsEarned: 1 });
    }
    tasks.push({ id: 't_1794519466363', title: 'מדעי המחשב', subjectId: 's1', dueDate: '2026-11-12', dueTime: '22:00', completed: true,
        completedAt: iso(L(2026, 11, 12, 23, 58)), autoPenaltyApplied: true, pointsEarned: 0 });
    tasks.push({ id: 't_1794519466364', title: 'חדש', dueDate: '2026-12-01', completed: true, completedAt: iso(L(2026, 11, 12, 23, 6)), pointsEarned: 1 });
    const hist = [2, 2, 1, 1, 2, 2].map((p, i) => ({ id: 'ph_' + i, taskId: 'h' + i, points: p, date: iso(L(2026, 11, 8 + (i % 4), 10 + i)) }));
    return {
        username: 'שליי', name: 'שלי', subjects: [{ id: 's1', name: 'מדעי המחשב', emoji: '💻' }],
        tasks, pointsHistory: hist, weeklyPoints: 24, totalPoints: 24, taskStreak: 1, longestStreak: 57,
        currentStreakStart: iso(L(2026, 11, 12, 23, 6)), lastSync: 5,
        streakHistory: [{ id: 'sh_1', startDate: null, endDate: iso(L(2026, 11, 12, 22)), length: 57, brokenByTaskId: 't_1794519466363' }],
    };
}

test('repairStreakDates: 57th-from-last rule, idempotent, null if underivable (bug: startDate null -> 1970)', () => {
    const u = shelyFixture();
    const r = sync.repairStreakDates(u);
    const counted = u.tasks.filter(t => new Date(t.completedAt).getTime() < L(2026, 11, 12, 22)).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    assert.strictEqual(r.streakHistory[0].startDate, new Date(counted[56].completedAt).toISOString());
    assert.strictEqual(r.streakHistory[0].startDate, u.tasks[78 - 57].completedAt);
    assert.strictEqual(sync.repairStreakDates(r), r); // idempotent: same reference
    assert.strictEqual(sync.contentHash(sync.repairStreakDates(r)), sync.contentHash(r));
    const none = sync.repairStreakDates({ tasks: [], streakHistory: [{ id: 's', startDate: null, endDate: iso(NOW), length: 5 }] });
    assert.strictEqual(none.streakHistory[0].startDate, null);
    const cur = sync.repairStreakDates({ ...u, currentStreakStart: null, streakHistory: [] });
    assert.ok(sync.isValidStart(cur.currentStreakStart));
});

test('currentStreakStart set whenever streak goes 0->>0 (verifyAndRepair)', () => {
    const u = { tasks: [{ id: 'a', completed: true, completedAt: '2026-11-01T10:00:00.000Z' }], taskStreak: 0, longestStreak: 1, currentStreakStart: null };
    const r = sync.verifyAndRepairStreakAndTasks(u);
    assert.strictEqual(r.taskStreak, 1);
    assert.ok(sync.isValidStart(r.currentStreakStart));
});

test('real-shape doc: heal adds missing late-task penalty row; list sum == headline; streak start valid (bug: table in plan)', () => {
    const u = shelyFixture();
    const h = sync.healCompletedFromHistory(sync.repairStreakDates(u), NOW);
    const pen = h.pointsHistory.filter(r => r.taskId === 't_1794519466363');
    assert.deepStrictEqual(pen.map(r => [r.id, r.points]), [['ph_pen1_t_1794519466363_' + L(2026, 11, 12, 22), -1]]);
    const win = sync.sumLedger(h.pointsHistory, { from: sync.getWindowStart(NOW) });
    assert.strictEqual(h.weeklyPoints, win);
    assert.strictEqual(win, 10 - 1 + 1); // 10 ledger rows, -1 late penalty, +1 healed row of the on-time task t_..364
    assert.ok(sync.isValidStart(h.streakHistory[0].startDate));
    const h2 = sync.healCompletedFromHistory(h, NOW);
    assert.strictEqual(sync.contentHash(h2), sync.contentHash(h));
    // through merge too
    const m = sync.mergeUserData(u, { ...u, lastSync: 6 }, undefined, { now: NOW });
    assert.strictEqual(m.weeklyPoints, sync.sumLedger(m.pointsHistory, { from: sync.getWindowStart(NOW) }));
    assert.strictEqual(m.pointsHistory.filter(r => r.id === 'ph_pen1_t_1794519466363_' + L(2026, 11, 12, 22)).length, 1);
});

// ---------- 6. merge/sync ----------
const base = (o = {}) => ({ username: 'u', name: 'u', tasks: [], pointsHistory: [], streakHistory: [], exams: [], badges: [],
    deletedTaskIds: [], deletedExamIds: [], taskStreak: 0, longestStreak: 0, lastSync: 0, ...o });

test('contentHash: stable over key order, array order, excludes lastSync', () => {
    const a = { x: 1, y: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }], lastSync: 5 };
    const b = { lastSync: 99, y: [{ v: 2, id: 'b' }, { v: 1, id: 'a' }], x: 1 };
    assert.strictEqual(sync.contentHash(a), sync.contentHash(b));
    assert.notStrictEqual(sync.contentHash(a), sync.contentHash({ ...a, x: 2 }));
});

test('repeated merge does not inflate lastSync nor change content (bug: Date.now() stamp on merge)', () => {
    const a = base({ lastSync: 100, tasks: [{ id: 't1', title: 'a', updatedAt: 10 }] });
    const b = base({ lastSync: 200, tasks: [{ id: 't1', title: 'b', updatedAt: 20 }] });
    let m = sync.mergeUserData(a, b, undefined, { now: NOW });
    assert.strictEqual(m.lastSync, 200);
    const h = sync.contentHash(m);
    for (let i = 0; i < 5; i++) m = sync.mergeUserData(m, b, undefined, { now: NOW });
    assert.strictEqual(m.lastSync, 200);
    assert.strictEqual(sync.contentHash(m), h);
    const aa = sync.mergeUserData(a, a, undefined, { now: NOW });
    assert.strictEqual(sync.contentHash(sync.mergeUserData(aa, a, undefined, { now: NOW })), sync.contentHash(aa));
});

test('new phone: empty/default local never beats cloud (bug: first-login bootstrap)', () => {
    const cloud = base({ lastSync: 1000, theme: 'dark', tasks: [{ id: 't1', title: 'x', updatedAt: 5, createdAt: 1 }],
        pointsHistory: [{ id: 'p1', taskId: 't1', points: 2, date: iso(L(2026, 11, 9)) }], taskStreak: 4, longestStreak: 9, schedule: [1, 2] });
    const phone = { username: 'u', name: 'u', tasks: [], pointsHistory: [], taskStreak: 0, theme: '', lastSync: 999999999999, schedule: [] };
    const m = sync.mergeUserData(phone, cloud, undefined, { now: NOW });
    // normal merge runs (heal etc.) with the empty copy forced to lose: content equals cloud's, order independent
    assert.strictEqual(m.tasks.length, 1);
    assert.strictEqual(m.pointsHistory.length, 1);
    assert.strictEqual(m.taskStreak, 4);
    assert.strictEqual(sync.contentHash(sync.mergeUserData(cloud, phone, undefined, { now: NOW })), sync.contentHash(m));
    assert.strictEqual(m.theme, 'dark');
    assert.strictEqual(sync.isEmptyLocal(phone), true);
    assert.strictEqual(sync.isEmptyLocal(cloud), false);
});

test('tasks without updatedAt do not lose to stale remote doc (bug: stale-wins)', () => {
    const local = base({ lastSync: 500, tasks: [{ id: 't1', title: 'edited on phone', createdAt: 1 }] });
    const remote = base({ lastSync: 100, tasks: [{ id: 't1', title: 'old', createdAt: 1 }] });
    assert.strictEqual(sync.mergeUserData(local, remote, undefined, { now: NOW }).tasks[0].title, 'edited on phone');
    assert.strictEqual(sync.mergeUserData(remote, local, undefined, { now: NOW }).tasks[0].title, 'edited on phone');
});

test('remote newer edits win over local when stamped (bug: remote tasks/settings lost)', () => {
    const local = base({ lastSync: 100, theme: 'a', tasks: [{ id: 't1', title: 'old', updatedAt: 10 }] });
    const remote = base({ lastSync: 90, theme: 'b', fieldUpdatedAt: { theme: 120 }, tasks: [{ id: 't1', title: 'new', updatedAt: 50 }] });
    const m = sync.mergeUserData(local, remote, undefined, { now: NOW });
    assert.strictEqual(m.tasks[0].title, 'new');
    assert.strictEqual(m.theme, 'b');
});

test('tombstones: deleted tasks/exams stay deleted; un-complete propagates via uncompletedAt', () => {
    const a = base({ lastSync: 1, deletedTaskIds: ['t9'], deletedExamIds: ['e9'], exams: [] });
    const b = base({ lastSync: 2, tasks: [{ id: 't9', title: 'x' }], exams: [{ id: 'e9', name: 'x' }, { id: 'e1', name: 'keep' }] });
    const m = sync.mergeUserData(a, b, undefined, { now: NOW });
    assert.deepStrictEqual(m.tasks, []);
    assert.deepStrictEqual(m.exams.map(e => e.id), ['e1']);
    const done = base({ lastSync: 1, tasks: [{ id: 't1', completed: true, completedAt: '2026-11-10T10:00:00.000Z', updatedAt: 10 }] });
    const undone = base({ lastSync: 2, tasks: [{ id: 't1', completed: false, uncompletedAt: Date.parse('2026-11-11T10:00:00.000Z'), updatedAt: 20 }] });
    for (const [x, y] of [[done, undone], [undone, done]]) {
        const r = sync.mergeUserData(x, y, undefined, { now: NOW });
        assert.strictEqual(r.tasks[0].completed, false);
    }
    const redone = base({ lastSync: 3, tasks: [{ id: 't1', completed: true, completedAt: '2026-11-12T10:00:00.000Z', updatedAt: 30 }] });
    assert.strictEqual(sync.mergeUserData(undone, redone, undefined, { now: NOW }).tasks[0].completed, true);
});

test('late submit on A while B closed, then B merges: ladder once, totals equal, list sum == headline (scenario 6)', () => {
    const due = L(2026, 11, 12, 22);
    const task = hw({ id: 't1', createdAt: due - 7 * 86400000, updatedAt: 1 });
    const common = base({ lastSync: 10, taskStreak: 57, longestStreak: 57, currentStreakStart: iso(L(2026, 9, 17, 8)), tasks: [task],
        pointsHistory: [{ id: 'ph_a', taskId: 'x', points: 3, date: iso(L(2026, 11, 9, 9)) }] });
    const doneAt = L(2026, 11, 12, 23, 58);
    const penA = sync.penaltyRowsFor(task, doneAt, common.pointsHistory);
    const A = { ...common, lastSync: 50, taskStreak: 0, currentStreakStart: null,
        tasks: [{ ...task, completed: true, completedAt: iso(doneAt), autoPenaltyApplied: true, updatedAt: 50 }],
        pointsHistory: [...penA, ...common.pointsHistory],
        streakHistory: [{ id: 'sh_1', startDate: common.currentStreakStart, endDate: iso(due), length: 57, brokenByTaskId: 't1' }] };
    // B was closed, opens 3 h after due and its own catch-up sweep charges step 1 with the same id
    const penB = sync.penaltyRowsFor(task, due + 3 * 3600000, common.pointsHistory);
    const B = { ...common, pointsHistory: [...penB, ...common.pointsHistory], lastSync: 60 };
    const n = L(2026, 11, 13, 9);
    const mB = sync.mergeUserData(B, A, undefined, { now: n });
    const mA = sync.mergeUserData(A, B, undefined, { now: n });
    for (const m of [mA, mB]) {
        assert.strictEqual(m.pointsHistory.filter(r => r.id === `ph_pen1_t1_${due}`).length, 1);
        assert.strictEqual(m.pointsHistory.filter(r => r.id.startsWith('ph_pen2_t1')).length, 0);
        assert.strictEqual(m.weeklyPoints, 2);
        assert.strictEqual(m.totalPoints, 2);
        assert.strictEqual(m.weeklyPoints, sync.sumLedger(m.pointsHistory, { from: sync.getWindowStart(n) }));
        assert.strictEqual(m.taskStreak, 0, 'stale streak 57 must not resurrect');
        assert.strictEqual(m.streakHistory.length, 1);
        assert.strictEqual(m.tasks[0].completed, true);
    }
    assert.strictEqual(sync.contentHash(mA), sync.contentHash(mB));
});

// ---- random replica convergence ----
function makeReplicaSim(seed, nReplicas, skews) {
    const rnd = mulberry32(seed);
    let tick = 1000;
    let nextId = 0;
    const reps = Array.from({ length: nReplicas }, () => base({ lastSync: 0, theme: 't0' }));
    const stamp = (i) => ++tick + (skews ? skews[i] : 0);
    const ops = [
        (r, i) => { const id = 't' + (nextId++); const s = stamp(i); return { ...r, tasks: [{ id, title: 'n' + s, dueDate: '2026-11-20', createdAt: s, updatedAt: s }, ...r.tasks], lastSync: s }; },
        (r, i) => { if (!r.tasks.length) return r; const k = Math.floor(rnd() * r.tasks.length); const s = stamp(i); return { ...r, lastSync: s, tasks: r.tasks.map((t, j) => j === k && !t.completed ? { ...t, title: 'e' + s, updatedAt: s } : t) }; },
        (r, i) => { const open = r.tasks.filter(t => !t.completed); if (!open.length) return r; const t = open[Math.floor(rnd() * open.length)]; const s = stamp(i); const at = iso(L(2026, 11, 10, 8) + s * 1000);
            return { ...r, lastSync: s, tasks: r.tasks.map(x => x.id === t.id ? { ...x, completed: true, completedAt: at, pointsEarned: 1, updatedAt: s } : x),
                pointsHistory: [{ id: 'ph_' + t.id, taskId: t.id, points: 1, date: at, details: 'ok' }, ...r.pointsHistory] }; },
        (r, i) => { if (!r.tasks.length) return r; const t = r.tasks[Math.floor(rnd() * r.tasks.length)]; const s = stamp(i); return { ...r, lastSync: s, tasks: r.tasks.filter(x => x.id !== t.id), deletedTaskIds: [...r.deletedTaskIds, t.id] }; },
        (r, i) => { const s = stamp(i); return { ...r, lastSync: s, theme: 't' + s, fieldUpdatedAt: { ...(r.fieldUpdatedAt || {}), theme: s } }; },
    ];
    return { reps, rnd, ops, now: NOW };
}
const merge2 = (x, y, now) => sync.mergeUserData(x, y, undefined, { now });

test('200 seeded random 3-replica sequences converge and merge is idempotent (scenario 2)', () => {
    for (let seed = 1; seed <= 200; seed++) {
        const sim = makeReplicaSim(seed, 3);
        const { reps, rnd, ops, now } = sim;
        for (let step = 0; step < 25; step++) {
            const i = Math.floor(rnd() * 3);
            if (rnd() < 0.6) reps[i] = ops[Math.floor(rnd() * ops.length)](reps[i], i);
            else { const j = Math.floor(rnd() * 3); if (j !== i) { const a = reps[i], b = reps[j]; reps[i] = merge2(a, b, now); reps[j] = merge2(b, a, now); } }
        }
        for (let round = 0; round < 2; round++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) reps[i] = merge2(reps[i], reps[j], now);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) reps[i] = merge2(reps[i], reps[j], now);
        const hs = reps.map(r => sync.contentHash(r));
        assert.ok(hs[0] === hs[1] && hs[1] === hs[2], 'diverged at seed ' + seed);
        const again = merge2(reps[0], reps[1], now);
        assert.strictEqual(sync.contentHash(again), hs[0], 'not idempotent at seed ' + seed);
        assert.strictEqual(again.lastSync, reps[0].lastSync);
        // no completion lost: every ledger row survives, totals derived
        assert.strictEqual(reps[0].totalPoints, sync.sumLedger(reps[0].pointsHistory, {}));
    }
});

test('commutativity: merge(a,b) == merge(b,a) for random pairs', () => {
    for (let seed = 300; seed < 360; seed++) {
        const { reps, rnd, ops, now } = makeReplicaSim(seed, 2);
        for (let s = 0; s < 12; s++) { const i = Math.floor(rnd() * 2); reps[i] = ops[Math.floor(rnd() * ops.length)](reps[i], i); }
        assert.strictEqual(sync.contentHash(merge2(reps[0], reps[1], now)), sync.contentHash(merge2(reps[1], reps[0], now)), 'seed ' + seed);
    }
});

test('clock skew +/-10 min: nothing lost, converges, lastSync never exceeds op stamps (scenario 4)', () => {
    for (let seed = 400; seed < 440; seed++) {
        const { reps, rnd, ops, now } = makeReplicaSim(seed, 3, [600, 0, -600]);
        for (let s = 0; s < 20; s++) { const i = Math.floor(rnd() * 3); reps[i] = ops[Math.floor(rnd() * ops.length)](reps[i], i); }
        const rows = new Set(reps.flatMap(r => r.pointsHistory.map(p => p.id)));
        for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) reps[i] = merge2(reps[i], reps[j], now);
        assert.strictEqual(new Set(reps.map(r => sync.contentHash(r))).size, 1, 'seed ' + seed);
        const deleted = new Set(reps[0].deletedTaskIds);
        for (const id of rows) assert.ok(reps[0].pointsHistory.some(p => p.id === id) || deleted.has(id.slice(3)), id); // rows of deleted tasks are dropped
        assert.ok(reps[0].lastSync < 1000 + 20 + 700, 'lastSync stamped from wall clock');
    }
});

test('offline edit, reload (JSON round trip), reconnect: both sides edits kept (scenario 3)', () => {
    const start = base({ lastSync: 10, tasks: [{ id: 't1', title: 'a', updatedAt: 1 }, { id: 't2', title: 'b', updatedAt: 1 }] });
    let phone = { ...start, lastSync: 20, tasks: [{ ...start.tasks[0], title: 'phone edit', updatedAt: 20 }, start.tasks[1]] };
    phone = JSON.parse(JSON.stringify(phone));
    const pc = { ...start, lastSync: 30, tasks: [start.tasks[0], { ...start.tasks[1], title: 'pc edit', updatedAt: 30 }] };
    const m = merge2(phone, pc, NOW);
    assert.deepStrictEqual(m.tasks.map(t => t.title).sort(), ['pc edit', 'phone edit']);
    assert.strictEqual(sync.contentHash(m), sync.contentHash(merge2(pc, phone, NOW)));
});

// ---------- 7. status ----------
test('computeSyncStatus table: green only when pull ok, outbox empty, push acked, hashes equal', () => {
    const ok = { pullOk: true, outboxCount: 0, lastPushAckAt: 5, localHash: 'h', cloudHash: 'h', lastError: null, online: true };
    const s = (o) => sync.computeSyncStatus({ ...ok, ...o });
    assert.strictEqual(s({}).state, 'synced');
    assert.strictEqual(s({ online: false }).state, 'offline');
    assert.strictEqual(s({ online: false, lastError: 'x' }).state, 'offline');
    assert.strictEqual(s({ lastError: 'permission-denied' }).state, 'error');
    assert.ok(s({ lastError: 'permission-denied' }).reason.includes('permission-denied'));
    for (const o of [{ pullOk: false }, { outboxCount: 2 }, { lastPushAckAt: null }, { lastPushAckAt: 0 }, { cloudHash: 'z' }, { cloudHash: null }, { localHash: undefined }]) {
        const r = s(o);
        assert.strictEqual(r.state, 'pending', JSON.stringify(o));
        assert.ok(r.reason && r.reason.length > 0);
    }
    assert.strictEqual(sync.computeSyncStatus({}).state, 'pending');
    assert.strictEqual(sync.computeSyncStatus({ online: false }).state, 'offline');
});
