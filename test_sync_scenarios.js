const assert = require('assert');
const helpers = require('./js/helpers.js');
const sync = require('./js/sync-helpers.js');

console.log('Running StudyStreak Sync Tests...');

// SCENARIO 1: The exact user bug:
// User on Computer completes 2 tasks (streak goes 46 -> 48, tasks completed, points earned).
// User opens Phone which has stale data (streak 46, tasks uncompleted).
// Phone opens, phone has a newer local timestamp (e.g. from app start).
// Test: Phone merges with Computer's remote state.
{
    const phoneLocal = {
        name: 'שלי',
        taskStreak: 46,
        longestStreak: 46,
        totalPoints: 100,
        weeklyPoints: 20,
        lastSync: 3000, // Newer local timestamp on phone
        tasks: [
            { id: 't1', title: 'להשלים את השיעור', completed: false, dueDate: '2026-10-30', dueTime: '23:59:59' },
            { id: 't2', title: 'מרוכבים קובץ 04', completed: false, dueDate: '2026-10-30', dueTime: '23:59:59' }
        ],
        pointsHistory: []
    };

    const computerRemote = {
        name: 'שלי',
        taskStreak: 48,
        longestStreak: 48,
        totalPoints: 104,
        weeklyPoints: 24,
        lastSync: 2000, // Computer submitted earlier
        tasks: [
            { id: 't1', title: 'להשלים את השיעור', completed: true, completedAt: '2026-10-30T21:28:10.630Z', pointsEarned: 2 },
            { id: 't2', title: 'מרוכבים קובץ 04', completed: true, completedAt: '2026-10-30T22:30:12.368Z', pointsEarned: 2 }
        ],
        pointsHistory: [
            { id: 'ph_1', taskId: 't1', points: 2, date: '2026-10-30T21:28:10.630Z', details: 'הוגש מוקדם! אלופה.' },
            { id: 'ph_2', taskId: 't2', points: 2, date: '2026-10-30T22:30:12.368Z', details: 'הוגש מוקדם! אלופה.' }
        ]
    };

    // Changed: totals are now derived from the merged ledger (no Math.max of stored numbers); `now` pinned to
// Sat 2026-10-31 noon so both ledger rows fall in the week window.
const merged = sync.mergeUserData(phoneLocal, computerRemote, undefined, { now: sync.jerusalemMs(2026, 10, 31, 12) });

    assert.strictEqual(merged.taskStreak, 48, 'Streak on phone must be 48!');
    assert.strictEqual(merged.longestStreak, 48, 'Longest streak must be 48!');
    // Was 104/24. Total 104 now comes from a permanent ph_opening_balance row (100) + ledger (4); weekly is the
    // ledger window sum (4), not the stored 24.
    assert.strictEqual(merged.totalPoints, 104, 'Total points must be 104 (ledger 4 + opening balance 100)!');
    assert.strictEqual(merged.weeklyPoints, 4, 'Weekly points must equal the ledger window sum!');
    assert.strictEqual(merged.tasks.length, 2, 'Must have 2 tasks!');
    assert.strictEqual(merged.tasks[0].completed, true, 'Task 1 must be completed!');
    assert.strictEqual(merged.tasks[1].completed, true, 'Task 2 must be completed!');
    assert.strictEqual(merged.pointsHistory.length, 3, 'Points history: 2 entries + opening balance row!');
    console.log('[PASS] Scenario 1: Phone successfully adopts Computer submissions without rollback!');
}

// SCENARIO 2: Computer receives phone update after phone synced
{
    const computerLocal = {
        name: 'שלי',
        taskStreak: 48,
        longestStreak: 48,
        totalPoints: 104,
        weeklyPoints: 24,
        lastSync: 2000,
        tasks: [
            { id: 't1', title: 'להשלים את השיעור', completed: true, completedAt: '2026-10-30T21:28:10.630Z', pointsEarned: 2 },
            { id: 't2', title: 'מרוכבים קובץ 04', completed: true, completedAt: '2026-10-30T22:30:12.368Z', pointsEarned: 2 }
        ],
        pointsHistory: [
            { id: 'ph_1', taskId: 't1', points: 2, date: '2026-10-30T21:28:10.630Z' },
            { id: 'ph_2', taskId: 't2', points: 2, date: '2026-10-30T22:30:12.368Z' }
        ]
    };

    // Phone had synced and has timestamp 3500
    const phoneRemote = {
        name: 'שלי',
        taskStreak: 48,
        longestStreak: 48,
        totalPoints: 104,
        weeklyPoints: 24,
        lastSync: 3500,
        tasks: [
            { id: 't1', title: 'להשלים את השיעור', completed: true, completedAt: '2026-10-30T21:28:10.630Z', pointsEarned: 2 },
            { id: 't2', title: 'מרוכבים קובץ 04', completed: true, completedAt: '2026-10-30T22:30:12.368Z', pointsEarned: 2 }
        ],
        pointsHistory: [
            { id: 'ph_1', taskId: 't1', points: 2, date: '2026-10-30T21:28:10.630Z' },
            { id: 'ph_2', taskId: 't2', points: 2, date: '2026-10-30T22:30:12.368Z' }
        ]
    };

    const merged = sync.applyRemoteUser(computerLocal, phoneRemote);
    assert.strictEqual(merged.taskStreak, 48);
    assert.strictEqual(merged.tasks.every(t => t.completed), true);
    console.log('[PASS] Scenario 2: Computer stays 100% consistent with phone!');
}

// SCENARIO 3: Independent offline progress on two devices
// Computer completed Task 1, Phone completed Task 2 while offline.
{
    const computerState = {
        name: 'שלי',
        taskStreak: 47,
        totalPoints: 102,
        weeklyPoints: 22,
        lastSync: 1000,
        tasks: [
            { id: 't1', title: 'Task 1', completed: true, pointsEarned: 2 },
            { id: 't2', title: 'Task 2', completed: false }
        ],
        pointsHistory: [
            { id: 'ph_comp', taskId: 't1', points: 2, date: '2026-10-30T10:00:00Z' }
        ]
    };

    const phoneState = {
        name: 'שלי',
        taskStreak: 47,
        totalPoints: 102,
        weeklyPoints: 22,
        lastSync: 1100,
        tasks: [
            { id: 't1', title: 'Task 1', completed: false },
            { id: 't2', title: 'Task 2', completed: true, pointsEarned: 2 }
        ],
        pointsHistory: [
            { id: 'ph_phone', taskId: 't2', points: 2, date: '2026-10-30T11:00:00Z' }
        ]
    };

    const merged = sync.mergeUserData(computerState, phoneState);
    assert.strictEqual(merged.tasks.length, 2);
    assert.strictEqual(merged.tasks[0].completed, true, 'Task 1 must stay completed!');
    assert.strictEqual(merged.tasks[1].completed, true, 'Task 2 must stay completed!');
    // two non-empty ledgers: no opening-balance mint during a two-sided merge (heal on a single device mints it)
    assert.strictEqual(merged.pointsHistory.length, 2, 'Both history logs must be merged!');
    console.log('[PASS] Scenario 3: Independent offline actions on both devices merged losslessly!');
}

// SCENARIO 4: WhatsApp Weekly Report Single-Send Invariant
// Computer sent report for '2026-W44'. Phone had stale state with empty report week.
// When phone syncs, it must NOT erase the '2026-W44' marker or sent timestamp!
{
    const stalePhone = {
        name: 'שלי',
        lastSync: 5000,
        lastWeeklyReportSentWeek: '',
        lastWeeklyReportSentTime: 0,
        tasks: []
    };

    const updatedComputer = {
        name: 'שלי',
        lastSync: 4000,
        lastWeeklyReportSentWeek: '2026-W44',
        lastWeeklyReportSentTime: 1793471000000,
        tasks: []
    };

    const merged = sync.mergeUserData(stalePhone, updatedComputer);
    assert.strictEqual(merged.lastWeeklyReportSentWeek, '2026-W44', 'Must keep week 44 report marker!');
    assert.strictEqual(merged.lastWeeklyReportSentTime, 1793471000000, 'Must keep sent timestamp!');
    console.log('[PASS] Scenario 4: WhatsApp weekly report marker preserved across stale devices!');
}

// SCENARIO 5: Badge Healing for Weekly Champion
// Stale device has 7 crowns due to old bug. Healing must restore Shely to 5 and Inbar to 4.
{
    const staleShely = {
        name: 'שלי',
        username: 'שליי',
        tasks: [],
        badges: [{ id: 'b_weekly_champ', count: 7 }]
    };
    const healed = sync.healCompletedFromHistory(staleShely);
    const champ = healed.badges.find(b => b.id === 'b_weekly_champ');
    assert.strictEqual(champ.count, 5, 'Shely must be healed to 5 crowns!');

    const staleInbar = {
        name: 'ענבר❤️',
        username: 'ענבר❤️',
        tasks: [],
        badges: [{ id: 'b_weekly_champ', count: 7 }]
    };
    const healedInbar = sync.healCompletedFromHistory(staleInbar);
    const champInbar = healedInbar.badges.find(b => b.id === 'b_weekly_champ');
    assert.strictEqual(champInbar.count, 5, 'Inbar must be healed to 5 crowns (including 2026-W45)!');
    console.log('[PASS] Scenario 5: Stale weekly champ badges correctly healed!');
}

// SCENARIO 6: Weekly Reset Cross-Device Invariant
// Computer has already completed the Sunday 00:00 reset (weeklyPoints = 0, nextWeeklyReset = 1794088800000).
// Phone opens with stale data from Saturday afternoon (weeklyPoints = 50, nextWeeklyReset = 1793484000000).
// Merge must adopt the new week's reset points (0) and NOT resurrect the old 50 points!
{
    const stalePhone = {
        name: 'שלי',
        username: 'שליי',
        weeklyPoints: 50,
        totalPoints: 120,
        nextWeeklyReset: 1793484000000,
        nextWeeklyCrowning: 1793476800000,
        tasks: []
    };

    const resetComputer = {
        name: 'שלי',
        username: 'שליי',
        weeklyPoints: 0,
        totalPoints: 120,
        nextWeeklyReset: 1794088800000,
        nextWeeklyCrowning: 1794081600000,
        tasks: []
    };

    const merged = sync.mergeUserData(stalePhone, resetComputer);
    assert.strictEqual(merged.weeklyPoints, 0, 'Weekly points must stay reset at 0, not 50!');
    assert.strictEqual(merged.nextWeeklyReset, 1794088800000, 'Must keep the new week reset target!');
    console.log('[PASS] Scenario 6: Stale device does not resurrect pre-reset weekly points!');
}

// SCENARIO 7: Future Crown Win Preservation (Week 46+)
// If Shely wins a future week (e.g. Week 46), healing must preserve 6 crowns!
{
    const shelyWeek46 = {
        name: 'שלי',
        username: 'שליי',
        tasks: [],
        badges: [{ id: 'b_weekly_champ', count: 6, wonWeeks: ['2026-W37', '2026-W38', '2026-W40', '2026-W42', '2026-W44', '2026-W46'], lastWonAt: '2026-11-15T00:00:00.000Z' }]
    };
    const healed = sync.healCompletedFromHistory(shelyWeek46);
    const champ = healed.badges.find(b => b.id === 'b_weekly_champ');
    assert.strictEqual(champ.count, 6, 'Future 6th crown (Week 46) must be preserved!');
    console.log('[PASS] Scenario 7: Future crown wins (Week 46+) are preserved and not capped!');
}

// SCENARIO 8: Overdue Task Breaks Streak Immediately & Prevents Resurrect
// If an uncompleted task is overdue, the streak must break to 0 immediately.
// Stale devices with an active streak must not resurrect it to > 0!
{
    const overdueTask = {
        id: 't_overdue_1',
        title: 'Overdue Task',
        completed: false,
        dueDate: '2026-11-12',
        dueTime: '22:00'
    };
    const staleDevice = {
        name: 'שלי',
        username: 'שליי',
        taskStreak: 57,
        longestStreak: 57,
        streakHistory: [{ id: 'sh_september_baseline', length: 17, endDate: '2026-09-01' }],
        tasks: [overdueTask]
    };
    const healed = sync.healCompletedFromHistory(staleDevice);
    assert.strictEqual(healed.taskStreak, 0, 'Active streak must break to 0 when task is overdue!');
    assert.strictEqual(healed.longestStreak, 57, 'Longest streak must be preserved at 57!');
    assert.strictEqual(healed.streakHistory.length, 1, 'Only the real broken streak should be recorded, fake baseline purged!');
    assert.strictEqual(healed.streakHistory[0].length, 57, 'Recorded broken streak must have length 57!');
    assert.ok(!healed.streakHistory.some(s => s.id === 'sh_september_baseline'), 'sh_september_baseline must be purged!');

    // Stale sync merge test
    const remoteDevice = {
        name: 'שלי',
        username: 'שליי',
        taskStreak: 57,
        longestStreak: 57,
        tasks: [overdueTask]
    };
    const localDevice = {
        name: 'שלי',
        username: 'שליי',
        taskStreak: 0,
        longestStreak: 57,
        tasks: [{ ...overdueTask, streakBreakProcessed: true }]
    };
    const merged = sync.mergeUserData(localDevice, remoteDevice);
    assert.strictEqual(merged.taskStreak, 0, 'Stale device must not resurrect taskStreak from 0 when overdue task is pending!');
    console.log('[PASS] Scenario 8: Overdue task breaks streak to 0 immediately and prevents resurrection!');
}

// SCENARIO 9: Saturday Midnight / Sunday 00:00 Weekly Boundary Invariant
// Any tasks completed on Saturday (including 22:15 Saturday) belong to the completed week.
// On Sunday 00:00+, getEffectiveWeeklyPoints must return strictly 0 if no tasks completed since Sunday 00:00!
{
    const nowSunday = new Date('2026-11-08T01:15:00.000+02:00').getTime(); // Sunday 01:15 Israel time
    const shelySunday = {
        name: 'שלי',
        username: 'שליי',
        weeklyPoints: 3, // stale cached weekly points
        lastWeekPoints: 9,
        lastCrownedWeekEnd: new Date('2026-11-08T00:00:00+02:00').getTime(),
        nextWeeklyReset: new Date('2026-11-15T00:00:00+02:00').getTime(),
        tasks: [
            { id: 't1', title: 'Friday task', completed: true, completedAt: '2026-11-06T15:25:00.000Z', pointsEarned: 3 },
            { id: 't2', title: 'Saturday night task', completed: true, completedAt: '2026-11-07T20:15:00.000Z', pointsEarned: 3 }
        ],
        pointsHistory: [
            { id: 'ph1', points: 3, date: '2026-11-06T15:25:00.000Z' },
            { id: 'ph2', points: 3, date: '2026-11-07T20:15:00.000Z' }
        ]
    };
    const eff = helpers.getEffectiveWeeklyPoints(shelySunday, nowSunday);
    assert.strictEqual(eff, 0, 'Effective weekly points on Sunday morning must be 0 when tasks were done before Sunday 00:00!');

    // Healing must also reset weeklyPoints to 0!
    const healed = sync.healCompletedFromHistory(shelySunday);
    assert.strictEqual(healed.weeklyPoints, 0, 'Healed weekly points must be 0!');
    console.log('[PASS] Scenario 9: Saturday tasks stay in previous week; Sunday starts at 0 points!');
}

// SCENARIO 10: Task Duration & Details Edit Cross-Device Sync
// Computer had task completed with 52 minutes (0.87h).
// User on Phone edited it to 67 minutes (1.12h) and updated title.
// Merge must preserve the newer 67 minutes and Phone's title.
{
    const compTask = {
        id: 't_edit_1',
        title: 'Original Title',
        completed: true,
        completedAt: '2026-11-08T18:00:00.000Z',
        pointsEarned: 3,
        studyDurationMinutes: 52,
        studyDurationHours: 0.87,
        studyTimeRange: "52 דקות",
        updatedAt: 1000
    };
    const phoneTask = {
        id: 't_edit_1',
        title: 'Updated on Phone',
        completed: true,
        completedAt: '2026-11-08T18:00:00.000Z',
        pointsEarned: 3,
        studyDurationMinutes: 67,
        studyDurationHours: 1.12,
        studyTimeRange: "שעה ו-7 דק'",
        updatedAt: 2000
    };
    const userComp = { name: 'שלי', username: 'שליי', lastSync: 1000, tasks: [compTask] };
    const userPhone = { name: 'שלי', username: 'שליי', lastSync: 2000, tasks: [phoneTask] };
    const merged = sync.mergeUserData(userComp, userPhone);
    const t = merged.tasks.find(x => x.id === 't_edit_1');
    assert.strictEqual(t.studyDurationMinutes, 67, 'Newer 67 minutes must win!');
    assert.strictEqual(t.studyDurationHours, 1.12, 'Newer 1.12h must win!');
    assert.strictEqual(t.title, 'Updated on Phone', 'Newer title must win!');
    console.log('[PASS] Scenario 10: Edited task duration (67 mins vs 52 mins) successfully wins via updatedAt!');
}

// SCENARIO 11: Task Edited Downwards (e.g. 60m down to 40m)
// If user corrected an overreported duration from 60 mins to 40 mins on Phone,
// the newer edit must NOT be ignored in favor of the larger number.
{
    const olderLarge = {
        id: 't_down_1',
        title: 'Homework',
        completed: true,
        completedAt: '2026-11-08T18:00:00.000Z',
        pointsEarned: 2,
        studyDurationMinutes: 60,
        studyDurationHours: 1.0,
        updatedAt: 1000
    };
    const newerCorrected = {
        id: 't_down_1',
        title: 'Homework',
        completed: true,
        completedAt: '2026-11-08T18:00:00.000Z',
        pointsEarned: 2,
        studyDurationMinutes: 40,
        studyDurationHours: 0.67,
        updatedAt: 3000
    };
    const userA = { name: 'שלי', username: 'שליי', lastSync: 1000, tasks: [olderLarge] };
    const userB = { name: 'שלי', username: 'שליי', lastSync: 3000, tasks: [newerCorrected] };
    const merged = sync.mergeUserData(userA, userB);
    const t = merged.tasks.find(x => x.id === 't_down_1');
    assert.strictEqual(t.studyDurationMinutes, 40, 'Newer corrected duration (40m) must win over older 60m!');
    console.log('[PASS] Scenario 11: Downwards duration edit (40m vs 60m) successfully wins via updatedAt!');
}

// SCENARIO 12: Subject Additions & Edits Cross-Device Sync
{
    const user1 = {
        name: 'שלי',
        username: 'שליי',
        lastSync: 1000,
        subjects: [
            { id: 's1', name: 'מתמטיקה', color: 'blue', updatedAt: 500 },
            { id: 's2', name: 'אנגלית', color: 'red', updatedAt: 500 }
        ]
    };
    const user2 = {
        name: 'שלי',
        username: 'שליי',
        lastSync: 2000,
        subjects: [
            { id: 's1', name: 'מתמטיקה 5 יח"ל', color: 'purple', updatedAt: 1500 },
            { id: 's3', name: 'פיזיקה', color: 'green', updatedAt: 1500 }
        ]
    };
    const merged = sync.mergeUserData(user1, user2);
    assert.strictEqual(merged.subjects.length, 3, 'All 3 unique subjects must be preserved!');
    const s1 = merged.subjects.find(s => s.id === 's1');
    assert.strictEqual(s1.name, 'מתמטיקה 5 יח"ל', 'Newer subject edit must win!');
    assert.strictEqual(s1.color, 'purple', 'Newer subject color must win!');
    console.log('[PASS] Scenario 12: Subjects merged losslessly and newer subject edits preserved!');
}

// SCENARIO 13: Deleted Subject Invariant
{
    const userWithSub = {
        name: 'שלי',
        username: 'שליי',
        lastSync: 1000,
        subjects: [{ id: 's_del', name: 'היסטוריה' }]
    };
    const userDeletedSub = {
        name: 'שלי',
        username: 'שליי',
        lastSync: 2000,
        subjects: [],
        deletedSubjectIds: ['s_del']
    };
    const merged = sync.mergeUserData(userWithSub, userDeletedSub);
    const s = merged.subjects.find(x => x.id === 's_del');
    assert.strictEqual(s, undefined, 'Deleted subject must NOT be resurrected!');
    assert.ok(merged.deletedSubjectIds.includes('s_del'), 'deletedSubjectIds must be preserved!');
    console.log('[PASS] Scenario 13: Deleted subject is not resurrected by stale device!');
}

// SCENARIO 14: Deleted Exam Invariant
{
    const userWithExam = {
        name: 'שלי',
        username: 'שליי',
        lastSync: 1000,
        exams: [{ id: 'ex_del', examName: 'מבחן ישן' }]
    };
    const userDeletedExam = {
        name: 'שלי',
        username: 'שליי',
        lastSync: 2000,
        exams: [],
        deletedExamIds: ['ex_del']
    };
    const merged = sync.mergeUserData(userWithExam, userDeletedExam);
    const e = merged.exams.find(x => x.id === 'ex_del');
    assert.strictEqual(e, undefined, 'Deleted exam must NOT be resurrected!');
    assert.ok(merged.deletedExamIds.includes('ex_del'), 'deletedExamIds must be preserved!');
    console.log('[PASS] Scenario 14: Deleted exam is not resurrected by stale device!');
}

// SCENARIO 15: Study Duration Hours/Minutes Self-Healing
{
    const userMismatchedDuration = {
        name: 'שלי',
        username: 'שליי',
        tasks: [
            { id: 't_heal_dur', completed: true, studyDurationMinutes: 90, studyDurationHours: null, studyTimeRange: null }
        ]
    };
    const healed = sync.healCompletedFromHistory(userMismatchedDuration);
    const t = healed.tasks[0];
    assert.strictEqual(t.studyDurationHours, 1.5, 'studyDurationHours must be auto-computed as 1.5h!');
    assert.strictEqual(t.studyTimeRange, "1 שע' ו-30 דק'", 'studyTimeRange must be formatted properly!');
    console.log('[PASS] Scenario 15: Task study duration hours and minutes healed into 100% lockstep!');
}

require('./tests/ledger_sync.js');
require('./tests/fixes.js');
require('./tests/fixes2.js');
require('./tests/fixes3.js');
require('./tests/fixes4.js');
const { stats } = require('./tests/harness.js');
if (stats.fail) { console.log(stats.fail + ' FAILED: ' + stats.failures.join(' | ')); process.exit(1); }
console.log('ALL TESTS PASSED SUCCESSFULLY! (' + stats.pass + ' tests + 8 legacy scenarios)');
