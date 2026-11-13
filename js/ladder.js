/* StudyStreak penalty-ladder sweep, late-submit rows, derived totals, edit stamps. UMD, pure (no wall clock, no I/O). */
(function (root) {
    const H = (typeof module !== 'undefined' && module.exports) ? require('./sync-helpers.js') : root;
    const DAY = 86400000;
    // capture the helper-provided versions NOW: in the browser H === root and this file re-exports same-named wrappers
    const HX = { hasStreakBreakFor: H.hasStreakBreakFor, refundCompletionRowsOnly: H.refundCompletionRowsOnly, refundPenaltiesIfNotOverdue: H.refundPenaltiesIfNotOverdue };

    /** Valid streak start for a record that ends at endMs: current start, else derived from tasks, else the end itself. */
    function safeStreakStart(user, endMs) {
        if (H.isValidStart(user.currentStreakStart)) return user.currentStreakStart;
        const d = H.deriveStreakStart(user.tasks, user.taskStreak, endMs + 1);
        return d || new Date(endMs).toISOString();
    }

    /** Headline totals come from the ledger (stored fields are only a cache). Legacy no-ledger docs keep stored values. */
    function withDerivedTotals(u, now) {
        if (!u) return u;
        const x = H.ensureOpeningBalance(u);
        if (!Array.isArray(x.pointsHistory) || !x.pointsHistory.length) return x;
        const t = H.deriveTotals(x, now);
        if (x.totalPoints === t.totalPoints && x.weeklyPoints === t.weeklyPoints) return x;
        return { ...x, totalPoints: t.totalPoints, weeklyPoints: t.weeklyPoints };
    }
    function headlineTotals(u, now) {
        if (!u) return { weeklyPoints: 0, totalPoints: 0 };
        if (Array.isArray(u.pointsHistory) && u.pointsHistory.length) return H.deriveTotals(u, now);
        return { weeklyPoints: Number(u.weeklyPoints) || 0, totalPoints: Number(u.totalPoints) || 0 };
    }

    /**
     * Binding ladder sweep. Mints missing ph_pen1_/ph_pen2_ rows, breaks the streak at the FIRST step (with a valid
     * streakHistory.startDate), stamps penaltyLadderStartedAt once (catch-up never charges tasks due before it).
     * @returns {{user:object, newRows:Array, broke:boolean}} user is the same reference when nothing changed.
     */
    function sweepLadder(user, nowMs, opts0) {
        const out = { user, newRows: [], broke: false };
        if (!user || !Array.isArray(user.tasks)) return out;
        let started = Number(user.penaltyLadderStartedAt) || 0;
        let changedStart = false;
        if (!started) {
            // stamp only after a successful first pull (or a non-fresh local doc the caller vouches for)
            if (!(opts0 && opts0.canStamp)) return out;
            started = nowMs; changedStart = true;
        }
        const ledger = Array.isArray(user.pointsHistory) ? user.pointsHistory : [];
        const subjects = user.subjects || [];
        const newRows = [];
        let breakTask = null, breakDue = Infinity;
        const streakStartMs = H.isValidStart(user.currentStreakStart) ? new Date(user.currentStreakStart).getTime() : 0;
        const touched = new Set();
        const seen = ledger.slice();
        const broken = new Set((user.streakHistory || []).map((h) => h && h.brokenByTaskId).filter(Boolean));
        for (const t of user.tasks) {
            if (!t || !t.id || H.isExemptTask(t) || t.givenUp) continue;
            if (H.isLockedTaskId && H.isLockedTaskId(t.id)) continue; // live-repo purged tasks: no ledger rows, ever (merge would drop them again)
            const done = t.completed || !!t.completedAt || H.taskLooksCompleted(t, ledger);
            const opts = { notBefore: started, now: nowMs };
            if (done) {
                const doneMs = t.completed ? new Date(t.completedAt).getTime() : NaN;
                if (!Number.isFinite(doneMs)) continue; // no usable completedAt: never guess a ladder
                const rows = H.penaltyRowsFor(t, nowMs, seen, subjects, opts);
                if (rows.length) { newRows.push(...rows); seen.push(...rows); touched.add(t.id); }
                continue;
            }
            const ev = H.evaluateLateness(t, null, nowMs);
            if (ev.step === 0) continue;
            const due = H.getDueMs(t);
            if (due < started) continue; // pre-release overdue task: no retro charge, no retro break
            const rows = H.penaltyRowsFor(t, nowMs, seen, subjects, opts);
            if (rows.length) { newRows.push(...rows); seen.push(...rows); touched.add(t.id); }
            // a task already recorded as a breaker never breaks again; only tasks due inside the running streak break it
            const relevant = !broken.has(t.id) && !t.streakBreakProcessed && (!streakStartMs || due >= streakStartMs - 5 * 60 * 1000);
            if (relevant && (Number(user.taskStreak) || 0) > 0 && due < breakDue) { breakTask = t; breakDue = due; }
        }
        if (!newRows.length && !breakTask && !changedStart) return out;
        let u = { ...user };
        if (changedStart) {
            u.penaltyLadderStartedAt = started;
            u.fieldUpdatedAt = { ...(user.fieldUpdatedAt || {}), penaltyLadderStartedAt: nowMs };
        }
        if (touched.size) u.tasks = user.tasks.map((t) => (touched.has(t.id) && !t.completed ? { ...t, autoPenaltyApplied: true } : t));
        if (newRows.length) u.pointsHistory = [...newRows, ...ledger];
        if (breakTask) {
            const len = Number(user.taskStreak) || 0;
            u.streakHistory = [...(user.streakHistory || []), {
                id: 'sh_brk_' + breakTask.id + '_' + breakDue,
                startDate: safeStreakStart(user, breakDue),
                endDate: new Date(breakDue).toISOString(),
                length: len,
                emojis: [...(user.currentStreakEmojis || [])],
                brokenByTaskId: breakTask.id,
            }];
            u.taskStreak = 0; u.currentStreakStart = null; u.currentStreakEmojis = [];
            out.broke = true;
        }
        out.newRows = newRows;
        out.user = withDerivedTotals(u, nowMs);
        return out;
    }

    /** Ladder rows a late submit writes (same rows the sweep would have written; idempotent by id; no extra charge). */
    function lateSubmitRows(user, task, completedMs, nowMs) {
        const done = { ...task, completed: true, completedAt: new Date(completedMs).toISOString() };
        const nb = Number(user.penaltyLadderStartedAt) || 0;
        return H.penaltyRowsFor(done, completedMs, user.pointsHistory || [], user.subjects || [], { ...(nb ? { notBefore: nb } : {}), now: nowMs });
    }

    const STAMP_SKIP = new Set(['tasks', 'exams', 'subjects', 'deletedSubjectIds', 'pointsHistory', 'streakHistory', 'deletedTaskIds', 'deletedExamIds', 'badges', 'taskStreak',
        'longestStreak', 'currentStreakStart', 'currentStreakEmojis', 'totalPoints', 'weeklyPoints', 'lastSync', 'fieldUpdatedAt', 'restoredBrokenIds',
        'lastCrownedWeekEnd', 'crownedWeekPoints', 'nextWeeklyCrowning', 'nextWeeklyReset', 'lastWeeklyReportSentWeek', 'lastWeeklyReportSentTime',
        'lastGlobalWhatsAppReminderSent', 'username', 'id']);
    /**
     * UI contract funnel: every task/exam object that changed gets updatedAt = now; every changed scalar settings key
     * gets fieldUpdatedAt[key] = now. Unchanged references/values keep their stamps.
     */
    function stampEdits(prev, next, nowMs) {
        if (!prev || !next || prev === next) return next;
        const out = { ...next };
        for (const k of ['tasks', 'exams']) {
            if (!Array.isArray(next[k]) || next[k] === prev[k]) continue;
            const old = new Map((Array.isArray(prev[k]) ? prev[k] : []).filter(Boolean).map((x) => [x.id, x]));
            out[k] = next[k].map((x) => {
                if (!x || typeof x !== 'object') return x;
                const o = old.get(x.id);
                if (o === x) return x;
                if (o && JSON.stringify(o) === JSON.stringify(x)) return x;
                if (o && x.updatedAt !== o.updatedAt) return x; // handler stamped it itself
                return { ...x, updatedAt: nowMs };
            });
        }
        let fu = null;
        for (const k of Object.keys(next)) {
            if (STAMP_SKIP.has(k)) continue;
            const a = prev[k], b = next[k];
            if (a === b) continue;
            let same = false;
            try { same = JSON.stringify(a) === JSON.stringify(b); } catch (e) {}
            if (same) continue;
            if (next.fieldUpdatedAt && next.fieldUpdatedAt[k] !== undefined && (!prev.fieldUpdatedAt || prev.fieldUpdatedAt[k] !== next.fieldUpdatedAt[k])) continue;
            fu = fu || { ...(next.fieldUpdatedAt || {}) };
            fu[k] = nowMs;
        }
        if (fu) out.fieldUpdatedAt = fu;
        return out;
    }

    /** True when the task already broke the streak (history record) or already has its step-1 ladder row. Prefers the helper export. */
    function hasStreakBreakFor(user, taskId) {
        if (typeof HX.hasStreakBreakFor === 'function') return HX.hasStreakBreakFor(user, taskId);
        if (!user || !taskId) return false;
        return (user.streakHistory || []).some((h) => h && h.brokenByTaskId === taskId) ||
            (user.pointsHistory || []).some((h) => h && String(h.id || '').startsWith('ph_pen1_' + taskId));
    }
    /** Un-complete: refund ONLY completion rows (positive, non-refund rows of the task) with ph_refund_<id> rows. */
    function refundCompletionRows(taskId, ledger, iso) {
        if (typeof HX.refundCompletionRowsOnly === 'function') return HX.refundCompletionRowsOnly(ledger, taskId, iso);
        const hist = Array.isArray(ledger) ? ledger : [];
        const have = new Set(hist.map((h) => h && h.id));
        return hist.filter((h) => h && h.taskId === taskId && !h.canceled && (h.points || 0) > 0 && !String(h.id).startsWith('ph_refund_') && !have.has('ph_refund_' + h.id))
            .map((h) => ({ id: 'ph_refund_' + h.id, taskId, taskTitle: h.taskTitle || '', subjectName: h.subjectName || '', subjectEmoji: h.subjectEmoji || '', points: -h.points, date: iso, details: 'ביטול הגשה (החזרת נקודות)' }));
    }
    /** Penalty refunds for the task, only when its (current) due date is no longer overdue. */
    function refundPenaltiesIfNotOverdue(task, ledger, iso, nowMs) {
        if (typeof HX.refundPenaltiesIfNotOverdue === 'function') return HX.refundPenaltiesIfNotOverdue(task, ledger, nowMs);
        if (!task || H.evaluateLateness(task, null, nowMs).late) return [];
        return H.refundRowsFor(task.id, ledger, iso, 'ביטול הגשה: החזר קנס');
    }

    const api = { hasStreakBreakFor, refundCompletionRows, refundPenaltiesIfNotOverdue, sweepLadder, lateSubmitRows, withDerivedTotals, headlineTotals, safeStreakStart, stampEdits };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    for (const k of Object.keys(api)) root[k] = api[k];
})(typeof globalThis !== 'undefined' ? globalThis : this);
