// Child process for the cross-timezone test: prints a digest that must not depend on the host TZ.
const H = require('../js/sync-helpers.js');
const iso = (s) => s;
const tasks = [];
for (let i = 0; i < 10; i++) tasks.push({ id: 'h' + i, title: 'w' + i, dueDate: '2026-12-01', completed: true, completedAt: new Date(Date.parse('2026-10-20T08:00:00Z') + i * 20 * 3600000).toISOString(), pointsEarned: 1 });
tasks.push({ id: 'late', title: 'cs', subjectId: 's1', dueDate: '2026-11-12', dueTime: '22:00', completed: true, completedAt: '2026-11-12T21:58:00.000Z', autoPenaltyApplied: true, updatedAt: 5 });
tasks.push({ id: 'dateonly', title: 'do', dueDate: '2026-11-12', completed: false, updatedAt: 3 });
const doc = { username: 'שליי', name: 'שלי', subjects: [{ id: 's1', name: 'cs', emoji: 'x' }], tasks, taskStreak: 1, longestStreak: 10, currentStreakStart: '2026-11-12T22:30:00.000Z', lastSync: 9,
    pointsHistory: [{ id: 'ph0', taskId: 'h0', points: 2, date: '2026-11-09T10:00:00.000Z' }, { id: 'ph1', taskId: 'h1', points: 2, date: '2026-11-10T10:00:00.000Z' }],
    streakHistory: [{ id: 'sh_1', startDate: null, endDate: '2026-11-12T20:00:00.000Z', length: 10, brokenByTaskId: 'late' }] };
const now = Date.parse('2026-11-13T10:00:00Z');
const m = H.mergeUserData(doc, JSON.parse(JSON.stringify(doc)), undefined, { now });
const m2 = H.mergeUserData(m, doc, undefined, { now });
const pen = m.pointsHistory.filter((r) => /^ph_pen/.test(r.id)).map((r) => r.id + ':' + r.points + ':' + r.date);
console.log(JSON.stringify({ h: H.contentHash(m), stable: H.contentHash(m2) === H.contentHash(m), pen, w: m.weeklyPoints, t: m.totalPoints, streak: m.taskStreak,
    late: m.tasks.find((t) => t.id === 'late').autoPenaltyApplied, win: H.getWindowStart(now), due: H.getDueMs({ dueDate: '2026-11-12', dueTime: '22:00' }), dueDO: H.getDueMs({ dueDate: '2026-03-27' }) }));
