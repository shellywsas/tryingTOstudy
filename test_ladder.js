const assert = require('assert');
const H = require('./js/sync-helpers.js');
const L = require('./js/ladder.js');
let n = 0; const ok = (m) => { n++; console.log('[PASS] ' + m); };
const T0 = H.jerusalemMs(2026, 11, 10, 12, 0); // Tue 12:00 Asia/Jerusalem (the fixed due-date timezone; host TZ independent)
const iso = (ms) => new Date(ms).toISOString();
const fmtJ = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const due = (ms) => { const o = {}; for (const x of fmtJ.formatToParts(new Date(ms))) o[x.type] = x.value; return { dueDate: `${o.year}-${o.month}-${o.day}`, dueTime: `${o.hour}:${o.minute}:00` }; };
const base = (extra) => ({ username: 'u', tasks: [], pointsHistory: [], streakHistory: [], subjects: [{ id: 's', name: 'מתמטיקה', emoji: '📐' }], taskStreak: 5, longestStreak: 5, totalPoints: 0, weeklyPoints: 0, currentStreakStart: null, currentStreakEmojis: [], ...extra });
const hw = (id, dueMs, extra) => ({ id, title: id, subjectId: 's', ...due(dueMs), completed: false, ...extra });

// A: step 1 charges -1, breaks the streak at once with a VALID start date (null start derived from tasks)
{
    const done = Array.from({ length: 5 }, (_, i) => ({ id: 'd' + i, title: 'd', completed: true, completedAt: iso(T0 - (10 - i) * 86400000), ...due(T0 - (10 - i) * 86400000 + 3600000) }));
    const u = base({ tasks: [...done, hw('late', T0 - 3600000)], penaltyLadderStartedAt: T0 - 86400000 * 30 });
    const r = L.sweepLadder(u, T0);
    assert.strictEqual(r.newRows.length, 1); assert.strictEqual(r.newRows[0].points, -1); assert.ok(r.newRows[0].id.startsWith('ph_pen1_late_'));
    assert.strictEqual(r.user.taskStreak, 0); assert.strictEqual(r.broke, true);
    const sh = r.user.streakHistory[0]; assert.ok(H.isValidStart(sh.startDate), 'valid start date'); assert.strictEqual(sh.length, 5);
    assert.strictEqual(r.user.weeklyPoints, -1); assert.strictEqual(r.user.totalPoints, -1);
    const r2 = L.sweepLadder(r.user, T0 + 60000); assert.strictEqual(r2.user, r.user, 'idempotent: same reference');
    ok('step 1: -1, streak breaks immediately with valid startDate, totals from ledger, idempotent');
}
// B: step 2 after 24h, exactly two rows total
{
    let u = base({ tasks: [hw('x', T0 - 3600000)], penaltyLadderStartedAt: 1 });
    u = L.sweepLadder(u, T0).user; u = L.sweepLadder(u, T0 + 24 * 3600000).user;
    const rows = u.pointsHistory.filter(H.isPenaltyRow); assert.strictEqual(rows.length, 2); assert.strictEqual(L.headlineTotals(u, T0 + 24 * 3600000).totalPoints, -2);
    u = L.sweepLadder(u, T0 + 48 * 3600000).user; assert.strictEqual(u.pointsHistory.filter(H.isPenaltyRow).length, 2, 'never more than 2');
    ok('step 2 after 24h: total -2, never a third charge');
}
// C: exempt tasks, grace, and pre-release tasks never charge; first run stamps penaltyLadderStartedAt
{
    const exempt = ['isLessonLog', 'isFlexibleExamSession', 'isPracticeSession', 'isExamPrep'].map((f, i) => hw('e' + i, T0 - 3 * 86400000, { [f]: true }));
    let u = base({ tasks: [...exempt, hw('grace', T0 - 60000), hw('old', T0 - 5 * 86400000)] });
    const r = L.sweepLadder(u, T0, { canStamp: true });
    assert.strictEqual(r.newRows.length, 0, 'exempt, within-grace and pre-release (first run) tasks are not charged');
    assert.strictEqual(r.user.penaltyLadderStartedAt, T0); assert.ok(r.user.fieldUpdatedAt.penaltyLadderStartedAt);
    assert.strictEqual(r.user.taskStreak, 5, 'no retro break');
    ok('exempt types, 5-min grace, and pre-release overdue tasks: no charge, no break');
}
// D: late submit writes the same ladder rows; sweep afterwards adds nothing (no double charge)
{
    const t = hw('s1', T0 - 3600000);
    const u = base({ tasks: [t], penaltyLadderStartedAt: 1 });
    const rows = L.lateSubmitRows(u, t, T0, T0); assert.strictEqual(rows.length, 1);
    const after = { ...u, tasks: [{ ...t, completed: true, completedAt: iso(T0) }], pointsHistory: rows };
    assert.strictEqual(L.sweepLadder(after, T0 + 5 * 3600000).newRows.length, 0);
    const rows2 = L.lateSubmitRows(u, t, T0 + 24 * 3600000, T0 + 24 * 3600000); assert.strictEqual(rows2.length, 2);
    ok('late submit <24h = -1, >=24h = -2, sweep after submit never double-charges');
}
// E: edit stamps funnel
{
    const prev = { tasks: [{ id: 'a', title: 'x', updatedAt: 5 }, { id: 'b', title: 'y' }], theme: 'light', exams: [] };
    const next = { ...prev, tasks: [{ id: 'a', title: 'x2', updatedAt: 5 }, prev.tasks[1]], theme: 'dark' };
    const s = L.stampEdits(prev, next, 99);
    assert.strictEqual(s.tasks[0].updatedAt, 99); assert.strictEqual(s.tasks[1], prev.tasks[1]); assert.strictEqual(s.fieldUpdatedAt.theme, 99);
    ok('edit funnel stamps changed tasks and changed scalars only');
}
// U1: breaker never re-breaks; B on time at 12:00 (streak 1) is not broken again by A's overdue
{
    const A = hw('A', T0 - 2 * 3600000); // due 10:00
    let u = base({ tasks: [A], taskStreak: 3, currentStreakStart: iso(T0 - 5 * 86400000), penaltyLadderStartedAt: 1 });
    u = L.sweepLadder(u, T0 - 3600000 + 5 * 60000).user; // 10:05 (A due 10:00 -> breaks)
    assert.strictEqual(u.taskStreak, 0); assert.strictEqual(u.streakHistory.length, 1);
    u = { ...u, tasks: [...u.tasks, { id: 'B', title: 'B', completed: true, completedAt: iso(T0), ...due(T0 + 3600000) }], taskStreak: 1, currentStreakStart: iso(T0) };
    for (let i = 0; i < 5; i++) u = L.sweepLadder(u, T0 + 60000 * (i + 1)).user;
    assert.strictEqual(u.taskStreak, 1); assert.strictEqual(u.streakHistory.length, 1, 'no repeated breaks');
    assert.ok(L.hasStreakBreakFor(u, 'A'));
    ok('U1: sweep never re-breaks for an already-recorded breaker or a task due before the running streak');
}
// U6: no stamp before first pull; sweep never bumps updatedAt
{
    const u = base({ tasks: [hw('x', T0 - 3600000)] });
    assert.strictEqual(L.sweepLadder(u, T0).user, u, 'no canStamp: untouched');
    const r = L.sweepLadder(u, T0, { canStamp: true });
    assert.ok(r.user.tasks[0].updatedAt === undefined, 'sweep output has no updatedAt bump');
    ok('U6: sweep waits for canStamp, never bumps task updatedAt');
}
// U5: un-complete refunds completion rows only; penalties only when no longer overdue
{
    const ledger = [{ id: 'ph_1', taskId: 'k', points: 2, date: iso(T0) }, { id: 'ph_pen1_k_1', taskId: 'k', points: -1, date: iso(T0) }];
    const undo = L.refundCompletionRows('k', ledger, iso(T0));
    assert.deepStrictEqual(undo.map((r) => [r.id, r.points]), [['ph_refund_ph_1', -2]]);
    const overdue = hw('k', T0 - 3600000), future = hw('k', T0 + 86400000);
    assert.strictEqual(L.refundPenaltiesIfNotOverdue(overdue, ledger, iso(T0), T0).length, 0, 'still overdue: penalty stays');
    assert.strictEqual(L.refundPenaltiesIfNotOverdue(future, ledger, iso(T0), T0).length, 1, 'no longer overdue: refunded');
    ok('U5: completion-only refund, conditional penalty refund');
}
console.log(`ladder: ${n} passed`);
