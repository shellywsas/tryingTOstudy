// Regression guards for the live repo's (shellywsas/tryingTOstudy) hotfixes v20261108..v20261113_9 on top of the ledger design.
const assert = require('assert');
const sync = require('../js/sync-helpers.js');
const ladder = require('../js/ladder.js');
const helpers = require('../js/helpers.js');
const { test } = require('./harness.js');
const L = (y, mo, d, h = 0, mi = 0, s = 0) => sync.jerusalemMs(y, mo, d, h, mi, s);
const iso = (ms) => new Date(ms).toISOString();
const NOW = L(2026, 11, 13, 12);
const base = (o = {}) => ({ username: 'u', name: 'u', tasks: [], pointsHistory: [], streakHistory: [], exams: [], badges: [], deletedTaskIds: [], deletedExamIds: [], taskStreak: 0, longestStreak: 0, lastSync: 0, ...o });
const mg = (a, b, now = NOW) => sync.mergeUserData(a, b, undefined, { now });

test('v7: test/verification tasks never enter a merge', () => {
    const t = (id, title) => ({ id, title, dueDate: '2026-12-01' });
    const m = mg(base({ tasks: [t('t_live_verify_1', 'x'), t('a', 'real')] }), base({ tasks: [t('b', 'לבדיקת סנכרון חי'), t('c', 'בדיקת סנכרון 2'), t('d', 'ok')] }));
    assert.deepStrictEqual(m.tasks.map((x) => x.id).sort(), ['a', 'd']);
});

test('v8/v9: bogus rows purged and not resurrected by a stale device; locked tasks stay uncompleted; later real submit allowed', () => {
    const rows = [
        { id: 'ph_t_1794473352381_x', taskId: 't_1794473352381', points: 2, date: '2026-11-12T10:00:00Z', subjectName: 'פיזיקה' },
        { id: 'ph_ok', taskId: 't_ok', points: 2, date: '2026-11-12T10:00:00Z', subjectName: 'אנגלית' },
        { id: 'ph_h', taskId: 't_h', points: 1, date: '2026-11-10T10:00:00Z', subjectName: 'היסטוריה' },
        { id: 'ph_t_1794521101639_1', taskId: 't_cs', points: 1, date: '2026-11-13T01:20:00Z', subjectName: 'מדעי המחשב' },
        { id: 'ph_late_h', taskId: 't_h2', points: 1, date: '2026-11-20T10:00:00Z', subjectName: 'היסטוריה' },
    ];
    const locked = { id: 't_1794473104904', title: 'מתמטיקה 11.11.26', dueDate: '2026-11-11', completed: true, completedAt: '2026-11-12T10:00:00Z', pointsEarned: 2, subjectId: 's' };
    const stale = base({ lastSync: 99, pointsHistory: rows, tasks: [locked] });
    let m = mg(base({ lastSync: 1 }), stale);
    assert.deepStrictEqual(m.pointsHistory.filter((r) => r.id !== 'ph_opening_balance').map((r) => r.id).sort(), ['ph_late_h', 'ph_ok']);
    const t = m.tasks.find((x) => x.id === locked.id);
    assert.ok(!t.completed && !t.completedAt);
    m = mg(m, stale); // idempotent against the stale copy
    assert.ok(!m.tasks.find((x) => x.id === locked.id).completed);
    assert.ok(sync.healCompletedFromHistory(stale, NOW).tasks.find((x) => x.id === locked.id).completed === false);
    const real = { ...locked, completed: true, completedAt: '2026-11-14T10:00:00Z', updatedAt: 5 };
    assert.ok(mg(base(), base({ tasks: [real] })).tasks[0].completed, 'a genuine later submission is not locked');
});

test('live: subjects merge per id, deletions tombstoned, concurrent adds on two devices both survive', () => {
    const A = base({ subjects: [{ id: 's1', name: 'a', updatedAt: 5 }, { id: 's2', name: 'gone', updatedAt: 1 }], deletedSubjectIds: [] });
    const B = base({ subjects: [{ id: 's1', name: 'b', updatedAt: 9 }, { id: 's3', name: 'new', updatedAt: 2 }], deletedSubjectIds: ['s2'] });
    const m = mg(A, B), m2 = mg(B, A);
    assert.deepStrictEqual(m.subjects.map((s) => s.id), ['s1', 's3']);
    assert.strictEqual(m.subjects[0].name, 'b');
    assert.deepStrictEqual(m.subjects, m2.subjects);
    assert.deepStrictEqual(m.deletedSubjectIds, ['s2']);
});

test('live: overdue task kills the streak immediately (heal), stale 57 does not resurrect in a merge, task due before the streak does not', () => {
    const overdue = { id: 'o1', title: 'x', dueDate: '2026-11-12', dueTime: '22:00', completed: false };
    const h = sync.healCompletedFromHistory(base({ taskStreak: 57, longestStreak: 57, tasks: [overdue], streakHistory: [{ id: 'sh_september_baseline', length: 17, endDate: '2026-09-01' }] }), NOW);
    assert.strictEqual(h.taskStreak, 0); assert.strictEqual(h.longestStreak, 57);
    assert.strictEqual(h.streakHistory.length, 1); assert.strictEqual(h.streakHistory[0].length, 57); assert.ok(sync.isValidStart(h.streakHistory[0].startDate));
    const m = mg(base({ taskStreak: 0, tasks: [{ ...overdue, streakBreakProcessed: true }] }), base({ taskStreak: 57, tasks: [overdue] }));
    assert.strictEqual(m.taskStreak, 0);
    // streak started AFTER the task's due time: the old overdue task must not break it
    const after = sync.healCompletedFromHistory(base({ taskStreak: 3, currentStreakStart: '2026-11-13T08:00:00.000Z', tasks: [overdue] }), NOW);
    assert.strictEqual(after.taskStreak, 3);
    // a task that already processed a break never breaks a rebuilt streak
    const done = sync.healCompletedFromHistory(base({ taskStreak: 3, tasks: [{ ...overdue, streakBreakProcessed: true }] }), NOW);
    assert.strictEqual(done.taskStreak, 3);
    // ladder sweep honours the same flag / start (no double break, no double charge)
    const r = ladder.sweepLadder(base({ taskStreak: 3, penaltyLadderStartedAt: 1, currentStreakStart: '2026-11-01T08:00:00.000Z', tasks: [{ ...overdue, streakBreakProcessed: true }] }), NOW, { canStamp: true });
    assert.ok(!r.broke);
});

test('live: week boundary is Sunday 00:00 (Saturday night counts to the ending week); no Shely 67->50 clamp; W45 belongs to Inbar', () => {
    assert.strictEqual(sync.getWindowStart(L(2026, 11, 14, 23, 30)), L(2026, 11, 8, 0));
    assert.strictEqual(sync.getWindowStart(L(2026, 11, 15, 0, 1)), L(2026, 11, 15, 0));
    assert.strictEqual(helpers.getCurrentWeekStart(L(2026, 11, 13, 9)), L(2026, 11, 8, 0));
    assert.strictEqual(helpers.getNextWeekReset(L(2026, 11, 13, 9)), L(2026, 11, 15, 0));
    const sat = { id: 'a', taskId: 't', points: 3, date: iso(L(2026, 11, 7, 22, 15)) };
    assert.strictEqual(sync.getEffectiveWeeklyPoints({ pointsHistory: [sat] }, L(2026, 11, 8, 1, 15)), 0);
    const s = mg(base({ username: 'שליי', name: 'שלי', taskStreak: 67, longestStreak: 67 }), base({ username: 'שליי', name: 'שלי', taskStreak: 67, longestStreak: 67 }));
    assert.strictEqual(s.taskStreak, 67);
    const champ = (w) => [{ id: 'b_weekly_champ', count: w.length, wonWeeks: w, lastWonAt: '2026-11-08T00:00:00Z' }];
    const shely = sync.healCompletedFromHistory(base({ username: 'שליי', name: 'שלי', badges: champ(['2026-W37', '2026-W38', '2026-W40', '2026-W42', '2026-W44', '2026-W45']) }), NOW);
    assert.ok(!shely.badges[0].wonWeeks.includes('2026-W45'));
    const inbar = sync.healCompletedFromHistory(base({ username: 'ענבר', name: 'ענבר', badges: champ(['2026-W36']) }), NOW);
    assert.ok(inbar.badges[0].wonWeeks.includes('2026-W45'));
});

test('live: studyDuration hours/minutes/range stay in lockstep on load', () => {
    const t = { id: 'd', title: 'x', completed: true, completedAt: '2026-11-12T10:00:00Z', studyDurationMinutes: 90, dueDate: '2026-11-13' };
    const h = sync.healCompletedFromHistory(base({ tasks: [t] }), NOW);
    assert.strictEqual(h.tasks[0].studyDurationHours, 1.5); assert.ok(h.tasks[0].studyTimeRange);
});

test('headline total = signed ledger sum on every replica: stale/higher/phantom stored totals + penalty row converge and stay stable (10 rounds)', () => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push({ id: 'ph_r' + i, taskId: 't' + i, points: i % 5 === 0 ? 3 : 5, date: iso(L(2026, 10, 1 + (i % 25), 10)), subjectName: 'x' });
    rows.push({ id: 'ph_pen1_t3_1', taskId: 't3', points: -1, date: iso(L(2026, 11, 12, 22)) });
    const truth = rows.reduce((a, r) => a + r.points, 0);
    const mk = (stored, ls, extra = {}) => base({ lastSync: ls, totalPoints: stored, weeklyPoints: 99, pointsHistory: rows, ...extra });
    let A = mk(truth + 40, 9), B = mk(truth - 4, 5), C = mk(truth + 11, 7, { pointsHistory: rows.slice(0, 41) });
    for (let i = 0; i < 10; i++) {
        A = sync.healCompletedFromHistory(mg(A, B), NOW); B = sync.healCompletedFromHistory(mg(B, C), NOW); C = sync.healCompletedFromHistory(mg(C, A), NOW);
        for (const r of [A, B, C]) assert.strictEqual(r.totalPoints, truth, 'round ' + i);
        assert.ok(!r0(A) && !r0(B) && !r0(C), 'no opening-balance row minted from a phantom stored total');
    }
    assert.strictEqual(ladder.headlineTotals(A, NOW).totalPoints, truth);
    assert.strictEqual(ladder.withDerivedTotals(mk(truth + 40, 1), NOW).totalPoints, truth);
});
function r0(u) { return u.pointsHistory.some((h) => h.id === 'ph_opening_balance'); }
