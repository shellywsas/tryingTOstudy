// Runaway headline total (owner complaint: 185 stored / 189 ledger, device showed 250+ and rising).
// Runs the heal pass 20x and 20 merge+heal rounds against an inflated stale replica on her-shaped data.
// Usage: node tests/runaway_total.js [path/to/sync-helpers.js]   (default: this repo's js/sync-helpers.js; also run against real/main's file)
const assert = require('assert');
const path = require('path');
const sync = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'js', 'sync-helpers.js')));
const iso = (ms) => new Date(ms).toISOString();
const D = (d, h = 10) => iso(Date.UTC(2026, 9, d, h));
const ledgerSum = (u) => (u.pointsHistory || []).filter((h) => h && !h.canceled).reduce((a, h) => a + (Number(h.points) || 0), 0);
const subjects = [{ id: 's_h', name: 'היסטוריה', emoji: 'H' }, { id: 's_e', name: 'אנגלית', emoji: 'E' }, { id: 's_m', name: 'מתמטיקה', emoji: 'M' }];
const tasks = [], rows = [];
// 30 normal completed tasks with rows, 5 completed HISTORY-subject tasks whose rows were purged, 3 completed tasks that still carry old auto-penalty rows
for (let i = 0; i < 30; i++) { const id = 't_n' + i; tasks.push({ id, title: 'n' + i, subjectId: i % 2 ? 's_e' : 's_m', completed: true, completedAt: D(1 + (i % 20)), pointsEarned: 2, dueDate: '2026-10-25', createdAt: D(1, 8) }); rows.push({ id: 'ph_' + id, taskId: id, points: 2, date: D(1 + (i % 20)), subjectName: i % 2 ? 'אנגלית' : 'מתמטיקה' }); }
for (let i = 0; i < 5; i++) tasks.push({ id: 't_h' + i, title: 'h' + i, subjectId: 's_h', completed: true, completedAt: D(2 + i), pointsEarned: 1, dueDate: '2026-10-25', createdAt: D(1, 8) });
for (let i = 0; i < 3; i++) { const id = 't_p' + i; tasks.push({ id, title: 'p' + i, subjectId: 's_e', completed: true, completedAt: D(5 + i), pointsEarned: 2, dueDate: '2026-10-25', createdAt: D(1, 8) }); rows.push({ id: 'ph_' + id, taskId: id, points: 2, date: D(5 + i), subjectName: 'אנגלית' }, { id: 'ph_auto_' + id + '_1', taskId: id, points: -2, date: D(5 + i, 20), subjectName: 'אנגלית' }); }
for (let i = 0; i < 4; i++) tasks.push({ id: 't_u' + i, title: 'u' + i, subjectId: 's_m', completed: false, dueDate: '2026-12-30' });
const her = (o = {}) => ({ username: 'u', name: 'u', subjects, tasks, pointsHistory: rows, streakHistory: [], badges: [], exams: [], deletedTaskIds: [], deletedExamIds: [], taskStreak: 0, longestStreak: 0, lastSync: 10, totalPoints: 185, weeklyPoints: 30, ...o });

let u = her(); const seen = [];
for (let i = 0; i < 20; i++) { u = sync.healCompletedFromHistory(u); seen.push(u.totalPoints); }
console.log('heal x20 totals:', seen.join(','), '| ledger sum now', ledgerSum(u));
const healGrows = new Set(seen).size > 1;

// merge rounds: local (healed) vs stale inflated replica that still holds the old penalty rows and total 400
const stale = her({ lastSync: 5, totalPoints: 400, weeklyPoints: 90 });
let m = her(); const seenM = [];
for (let i = 0; i < 20; i++) { m = sync.healCompletedFromHistory(sync.mergeUserData(m, stale)); seenM.push(m.totalPoints); }
console.log('merge+heal x20 totals:', seenM.join(','), '| ledger sum now', ledgerSum(m));

try {
    assert.strictEqual(healGrows, false, 'heal pass changes totalPoints between passes: ' + seen.slice(0, 6).join(','));
    for (const t of seen) assert.strictEqual(t, ledgerSum(u), 'heal total != ledger signed sum');
    assert.strictEqual(new Set(seenM).size, 1, 'merge+heal totals not constant: ' + seenM.slice(0, 6).join(','));
    for (const t of seenM) assert.strictEqual(t, ledgerSum(m), 'merged total != ledger signed sum (inflated stale replica won)');
    console.log('RUNAWAY TEST: PASS');
} catch (e) { console.log('RUNAWAY TEST: FAIL - ' + e.message); process.exit(1); }
