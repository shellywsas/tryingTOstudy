const assert = require('assert');
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

    const merged = sync.applyRemoteUser(phoneLocal, computerRemote);

    assert.strictEqual(merged.taskStreak, 48, 'Streak on phone must be 48!');
    assert.strictEqual(merged.longestStreak, 48, 'Longest streak must be 48!');
    assert.strictEqual(merged.totalPoints, 104, 'Total points must be 104!');
    assert.strictEqual(merged.weeklyPoints, 24, 'Weekly points must be 24!');
    assert.strictEqual(merged.tasks.length, 2, 'Must have 2 tasks!');
    assert.strictEqual(merged.tasks[0].completed, true, 'Task 1 must be completed!');
    assert.strictEqual(merged.tasks[1].completed, true, 'Task 2 must be completed!');
    assert.strictEqual(merged.pointsHistory.length, 2, 'Points history must have 2 entries!');
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
    assert.strictEqual(champInbar.count, 4, 'Inbar must be healed to 4 crowns!');
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

// SCENARIO 7: Future Crown Win Preservation (Week 45+)
// Shely wins her 6th crown on Saturday Nov 7, 2026. Healing must preserve 6 crowns!
{
    const shelyWeek45 = {
        name: 'שלי',
        username: 'שליי',
        tasks: [],
        badges: [{ id: 'b_weekly_champ', count: 6, lastWonAt: '2026-11-07T22:00:00.000Z' }]
    };
    const healed = sync.healCompletedFromHistory(shelyWeek45);
    const champ = healed.badges.find(b => b.id === 'b_weekly_champ');
    assert.strictEqual(champ.count, 6, 'Future 6th crown must be preserved and NOT capped at 5!');
    console.log('[PASS] Scenario 7: Future crown wins (6+) are preserved and not capped!');
}

console.log('ALL TESTS PASSED SUCCESSFULLY! 🚀');
