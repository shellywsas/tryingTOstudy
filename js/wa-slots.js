/* StudyStreak WhatsApp send slots. UMD, pure except claim/mark (Firestore). One claim doc per slot => one device sends.
 * Slots are computed in Asia/Jerusalem time: reminders 17:00 and 20:00 daily, parent report Saturday 19:00. */
(function (root) {
    const TZ = 'Asia/Jerusalem';
    const CLAIM_RETRY_MS = 10 * 60 * 1000;   // a FAILED slot may be retried after this
    const MAX_ATTEMPTS = 3;
    const DEFAULTS = { reminderSlots: ['17:00', '20:00'], reminderGraceMin: 90, weeklyTime: '19:00', weeklyGraceHours: 17 };

    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    function jerusalemParts(ms) {
        const p = {};
        for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
        const hh = Number(p.hour) % 24;
        return { date: `${p.year}-${p.month}-${p.day}`, minutes: hh * 60 + Number(p.minute), dow: DOW[p.weekday] };
    }
    function addDays(dateStr, n) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    }
    function hm(s) { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); }

    /** Slots that are due right now. Late catch-up only inside the grace window; never a stale slot. */
    function dueSlots(nowMs, cfg0) {
        const cfg = Object.assign({}, DEFAULTS, cfg0 || {});
        const t = jerusalemParts(nowMs);
        const out = [];
        for (const s of cfg.reminderSlots || []) {
            const start = hm(s);
            if (t.minutes >= start && t.minutes < start + cfg.reminderGraceMin) out.push({ kind: 'reminder', id: `rem-${t.date}-${String(s).replace(':', '')}` });
        }
        const wk = hm(cfg.weeklyTime), graceMin = cfg.weeklyGraceHours * 60;
        let sat = null;
        if (t.dow === 6 && t.minutes >= wk) sat = t.date;                                   // Saturday, from 19:00
        else if (t.dow === 0 && 1440 + t.minutes < wk + graceMin) sat = addDays(t.date, -1); // Sunday catch-up
        if (sat) out.push({ kind: 'weekly', id: `weekly-${sat}`, weekStart: addDays(sat, -6), weekEnd: sat });
        return out;
    }

    /** Pure: the tasks a reminder mentions (same rule as before: overdue or due within 48 h, at most `max`). */
    function pickReminderTasks(tasks, nowMs, max) {
        max = max || 3;
        const key = t => `${t.dueDate}T${t.dueTime || '23:59'}`;
        const active = (tasks || [])
            .filter(t => !t.completed && !t.givenUp && !t.isLessonLog && t.whatsappRemindersEnabled !== false && t.dueDate)
            .sort((a, b) => new Date(key(a)) - new Date(key(b)));
        const urgent = active.filter(t => {
            const ms = new Date(key(t)).getTime();
            return !isNaN(ms) && (ms - nowMs) / 3600000 <= 48;
        });
        return urgent.length ? urgent.slice(0, max) : active.slice(0, 1);
    }

    const claimRef = (db, docId, slotId) => db.collection('users').doc(docId).collection('sendClaims').doc(slotId);

    /** Transaction claim. Returns true only for the single winner. A crashed 'sending' claim is never retried
     *  (it may have been sent): duplicates are worse than a missed reminder. Only 'failed' retries, up to MAX_ATTEMPTS. */
    function claimSlot(db, docId, slotId, deviceId, nowMs) {
        const ref = claimRef(db, docId, slotId);
        return db.runTransaction(async tx => {
            const s = await tx.get(ref);
            let attempts = 0;
            if (s.exists) {
                const c = s.data() || {};
                if (c.status !== 'failed') return false;
                if (nowMs - (c.finishedAt || 0) < CLAIM_RETRY_MS) return false;
                attempts = c.attempts || 0;
                if (attempts >= MAX_ATTEMPTS) return false;
            }
            tx.set(ref, { status: 'sending', deviceId, claimedAt: nowMs, attempts: attempts + 1 });
            return true;
        });
    }
    function markSlot(db, docId, slotId, status, nowMs, err) {
        return claimRef(db, docId, slotId).set({ status, finishedAt: nowMs, error: err ? String(err).slice(0, 200) : null }, { merge: true });
    }

    const api = { TZ, DEFAULTS, CLAIM_RETRY_MS, MAX_ATTEMPTS, jerusalemParts, dueSlots, pickReminderTasks, claimSlot, markSlot };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WaSlots = api;
})(typeof window !== 'undefined' ? window : globalThis);
