/* StudyStreak sync helpers — plain JS, browser + node --test */
(function (root) {
    // ---------------------------------------------------------------- utils
    /**
     * Any date-ish value to ms: number, numeric string, ISO string, Date, Firestore Timestamp
     * ({seconds,nanoseconds} | {_seconds} | toMillis() | toDate()). NaN when unusable.
     */
    function toMs(v) {
        if (v === null || v === undefined || v === '') return NaN;
        if (v instanceof Date) return v.getTime();
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
            if (/^\d{9,}(\.\d+)?$/.test(v.trim())) return Number(v);
            return new Date(v).getTime();
        }
        if (typeof v === 'object') {
            if (typeof v.toMillis === 'function') return v.toMillis();
            if (typeof v.toDate === 'function') return v.toDate().getTime();
            const sec = v.seconds !== undefined ? v.seconds : v._seconds;
            if (sec !== undefined) {
                const ns = v.nanoseconds !== undefined ? v.nanoseconds : (v._nanoseconds || 0);
                return Number(sec) * 1000 + Math.floor(Number(ns) / 1e6);
            }
        }
        return NaN;
    }
    function msOr0(v) {
        const n = toMs(v);
        return Number.isFinite(n) ? n : 0;
    }
    function isTimestampLike(v) {
        return !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) &&
            (typeof v.toMillis === 'function' || (v.seconds !== undefined && Object.keys(v).every((k) => k === 'seconds' || k === 'nanoseconds')) ||
                (v._seconds !== undefined && Object.keys(v).every((k) => k === '_seconds' || k === '_nanoseconds')));
    }

    /** Server-only / metadata keys excluded from contentHash (top level). UI hashes the decoded, normalised doc on both sides. */
    const HASH_IGNORE_KEYS = ['lastSync', 'updateTime', 'createTime', '__serverUpdatedAt', '_serverTimestamp'];

    /** Stable JSON: sorted keys; arrays canonicalised then sorted; Date/Timestamp -> ISO; undefined dropped. */
    function canon(v) {
        if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
        if (isTimestampLike(v)) { const ms = toMs(v); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
        if (Array.isArray(v)) return v.map(canon).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x));
        if (v && typeof v === 'object') {
            const o = {};
            for (const k of Object.keys(v).sort()) {
                if (v[k] !== undefined) o[k] = canon(v[k]);
            }
            return o;
        }
        return v;
    }
    function stableStringify(v) { return JSON.stringify(canon(v)); }

    /** cyrb53 hash of the canonical content of a user doc (HASH_IGNORE_KEYS excluded). */
    function contentHash(user) {
        let copy = user;
        if (user && typeof user === 'object' && !Array.isArray(user) && !isTimestampLike(user) && !(user instanceof Date)) {
            const n = normalizeDoc(user);
            copy = { ...(n.error ? user : n.doc) };
            for (const k of HASH_IGNORE_KEYS) delete copy[k];
        }
        const str = stableStringify(copy === undefined ? null : copy);
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
    }

    /** Deterministic tie-break: returns >0 if a sorts after b by canonical content. */
    function cmpDet(a, b) {
        const x = stableStringify(a), y = stableStringify(b);
        return x < y ? -1 : x > y ? 1 : 0;
    }
    function isNil(v) { return v === null || v === undefined; }

    // ------------------------------------------------------------ exemptions
    /** Tasks that never break the streak and never get a lateness penalty. */
    function isExemptTask(task) {
        if (!task) return false;
        return !!(task.isLessonLog || task.isFlexibleExamSession || task.isPracticeSession || task.isExamPrep || task.rewardPoints);
    }

    const GRACE_MS = 5 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Due dates and the weekly window are wall-clock times in ONE fixed timezone (not the host's), so every device
    // computes the same instant, ids and week window. Intl is only used for the Asia/Jerusalem UTC-offset lookup.
    const DUE_TZ = 'Asia/Jerusalem';
    let tzFmt = null;
    function tzParts(ms) {
        if (!tzFmt) tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: DUE_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        const o = {};
        for (const p of tzFmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
        return o;
    }
    function tzOffsetAt(ms) {
        const p = tzParts(ms);
        return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
    }
    /**
     * Wall clock time in Asia/Jerusalem -> UTC ms. DST gap (e.g. 02:30 on 2026-03-27 does not exist): the result is
     * deterministic (the same instant on every device, the offset of the pre-gap rule), never NaN; ambiguous autumn
     * times resolve to one fixed side. Only determinism matters for ids and ladder steps.
     */
    function jerusalemMs(y, mo, d, h, mi, s) {
        const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
        const t = guess - tzOffsetAt(guess);
        return guess - tzOffsetAt(t);
    }

    /** Due instant in ms: dueDate + dueTime as Asia/Jerusalem wall time, date-only = 23:59:59. NaN when absent/invalid. */
    function getDueMs(task) {
        if (!task || !task.dueDate) return NaN;
        const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(task.dueDate));
        const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(task.dueTime || '23:59:59'));
        if (!dm || !tm) return NaN;
        const h = Number(tm[1]), mi = Number(tm[2]), sec = Number(tm[3] || 0);
        if (h > 23 || mi > 59 || sec > 59) return NaN;
        return jerusalemMs(Number(dm[1]), Number(dm[2]), Number(dm[3]), h, mi, sec);
    }

    /**
     * Single lateness rule (binding ladder).
     * ref = completedAt when given, else now. late = ref > due + 5 min grace.
     * step 0 = on time, 1 = overdue (-1 and streak break), 2 = >= 24h after the due time (another -1).
     * Exempt tasks, tasks without a valid due moment: never late.
     * @returns {{late:boolean,hoursLate:number,step:0|1|2}}
     */
    function evaluateLateness(task, completedAt, now) {
        const none = { late: false, hoursLate: 0, step: 0 };
        if (!task || isExemptTask(task)) return none;
        const due = getDueMs(task);
        if (!Number.isFinite(due)) return none;
        const ref = !isNil(completedAt) ? toMs(completedAt) : (!isNil(now) ? toMs(now) : Date.now());
        if (!Number.isFinite(ref)) return none;
        if (ref <= due + GRACE_MS) return none;
        const hoursLate = (ref - due) / 3600000;
        return { late: true, hoursLate, step: ref - due >= DAY_MS ? 2 : 1 };
    }

    // ---------------------------------------------------------------- ledger
    function isAutoHistoryId(id) {
        const s = String(id || "");
        return s.startsWith("ph_auto_") || s.startsWith("ph_refund_") || s.startsWith("ph_pen1_") || s.startsWith("ph_pen2_");
    }

    /** Negative automatic penalty row (legacy ph_auto_* or ladder ph_pen1_/ph_pen2_), not canceled. */
    function isPenaltyRow(h) {
        if (!h || h.canceled || !((h.points || 0) < 0)) return false;
        const id = String(h.id || "");
        return id.startsWith("ph_auto_") || id.startsWith("ph_pen1_") || id.startsWith("ph_pen2_");
    }

    /** Single week-window source: last Sunday 00:00:00 Asia/Jerusalem (ms), host-TZ independent (live repo rule: all of Saturday belongs to the week that ends). */
    /** Next Sunday 00:00 Asia/Jerusalem strictly after getWindowStart(now) (== window end). */
    function nextWindowStart(now) {
        const ws = getWindowStart(now);
        const p = tzParts(ws);
        const day = new Date(Date.UTC(p.year, p.month - 1, p.day + 7));
        return jerusalemMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, 0);
    }
    // Same names as before, now Jerusalem based so every caller agrees with getWindowStart in any host timezone.
    function getLastSaturday22PM(now) { return getWindowStart(now); }
    function getNextSaturday22PM(now) { return nextWindowStart(now); }

    function getWindowStart(now) {
        let ms = now === undefined || now === null ? Date.now() : toMs(now);
        if (!Number.isFinite(ms)) ms = Date.now(); // NaN/unparseable never throws
        const p = tzParts(ms);
        const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday .. 6 = Saturday
        const day = new Date(Date.UTC(p.year, p.month - 1, p.day - wd));
        return jerusalemMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, 0);
    }
    function getCurrentWeekStart(now) { return getWindowStart(now); }
    function getNextWeekReset(now) { return nextWindowStart(now); }
    function getLastWeekReset(now) { return getWindowStart(now); }
    /** Weekly points = signed ledger sum since the window start; no-ledger legacy docs: completed tasks of this week (live repo rule, never stale points). */
    function getEffectiveWeeklyPoints(userData, nowInput) {
        if (!userData) return 0;
        const now = nowInput === undefined || nowInput === null ? Date.now() : (toMs(nowInput));
        const ws = getWindowStart(now);
        if (Array.isArray(userData.pointsHistory) && userData.pointsHistory.length) return sumLedger(userData.pointsHistory, { from: ws });
        let sum = 0;
        for (const t of Array.isArray(userData.tasks) ? userData.tasks : []) {
            if (!t || !t.completed || !t.completedAt || t.givenUp) continue;
            const ct = toMs(t.completedAt);
            if (Number.isFinite(ct) && ct >= ws && ct <= now) sum += (t.pointsEarned || 1);
        }
        return sum;
    }

    /** Sum of signed, non-canceled ledger entries; optional inclusive {from,to} (ms) on entry date. */
    function sumLedger(pointsHistory, range) {
        const from = range && range.from !== undefined ? range.from : -Infinity;
        const to = range && range.to !== undefined ? range.to : Infinity;
        const bounded = from !== -Infinity || to !== Infinity;
        let sum = 0;
        for (const h of Array.isArray(pointsHistory) ? pointsHistory : []) {
            if (!h || h.canceled) continue;
            const p = Number(h.points);
            if (!Number.isFinite(p)) continue;
            if (bounded) {
                const t = toMs(h.date);
                if (!Number.isFinite(t) || t < from || t > to) continue;
            }
            sum += p;
        }
        return sum;
    }

    /** Headline numbers derived from the ledger only. */
    function deriveTotals(user, now) {
        const hist = user && user.pointsHistory;
        return {
            weeklyPoints: sumLedger(hist, { from: getWindowStart(now) }),
            totalPoints: sumLedger(hist, {}),
        };
    }

    function rowStep(h) {
        const id = String(h.id || '');
        return id.startsWith('ph_pen1_') ? 1 : id.startsWith('ph_pen2_') ? 2 : 0;
    }
    function rowDueMs(h) {
        if (Number.isFinite(Number(h.dueMs))) return Number(h.dueMs);
        const m = /_(\d{10,})$/.exec(String(h.id || ''));
        return m ? Number(m[1]) : NaN;
    }
    // A row whose due instant is the same wall-clock due read in another host timezone (offset UTC-12..+14,
    // multiple of 15 min). Distinct due-date edits are >= 24h apart and never match.
    function isDueVariant(rowDue, due) {
        if (!Number.isFinite(rowDue) || !Number.isFinite(due)) return false;
        const diff = due + tzOffsetAt(due) - rowDue;
        return diff % 900000 === 0 && diff >= -12 * 3600000 && diff <= 14 * 3600000;
    }

    // Per-ledger index (ids + rows by task), cached on the array object and extended incrementally when rows are
    // appended (sweeps push rows as they go); rebuilt when the array was replaced/reordered. Keeps a sweep of N tasks
    // O(N) instead of O(N * ledger).
    const ledgerIdxCache = new WeakMap();
    function ledgerIndex(ledger) {
        const n = ledger.length;
        let c = ledgerIdxCache.get(ledger);
        if (!(c && n >= c.len && (c.len === 0 || ledger[c.len - 1] === c.last))) {
            c = { len: 0, last: null, ids: new Set(), byTask: new Map() };
            ledgerIdxCache.set(ledger, c);
        }
        for (let i = c.len; i < n; i++) {
            const h = ledger[i];
            if (!h) continue;
            const id = String(h.id);
            c.ids.add(id);
            const keys = [];
            if (h.taskId) keys.push(h.taskId);
            else {
                // legacy rows without taskId: index under the remainder and, if it ends in _<digits>, the stripped task id
                const m = /^ph_(?:auto|pen[12])_(.+)$/.exec(id);
                if (m) { keys.push(m[1]); const t = /^(.+)_\d+$/.exec(m[1]); if (t) keys.push(t[1]); }
            }
            for (const key of keys) { const a = c.byTask.get(key); if (a) a.push(h); else c.byTask.set(key, [h]); }
        }
        c.len = n;
        c.last = n ? ledger[n - 1] : null;
        return c;
    }

    function ledgerIdSet(ledger) {
        return new Set((Array.isArray(ledger) ? ledger : []).filter(Boolean).map((h) => String(h.id)));
    }

    /** Ledger row belongs to the task: taskId field, or legacy ph_auto_<taskId>_<ts> id without a taskId field. */
    function rowBelongsTo(h, taskId) {
        if (!h) return false;
        if (h.taskId === taskId) return true;
        if (h.taskId) return false;
        const id = String(h.id || '');
        // legacy rows without a taskId field: ph_auto_<task>[_ts], ph_pen1|2_<task>[_dueMs]
        return id === 'ph_auto_' + taskId || id.startsWith('ph_auto_' + taskId + '_') || id === 'ph_pen1_' + taskId || id === 'ph_pen2_' + taskId ||
            id.startsWith('ph_pen1_' + taskId + '_') || id.startsWith('ph_pen2_' + taskId + '_');
    }

    /** A penalty row counts as an active charge unless a ph_refund_<penId> row exists for it. */
    function isRefunded(h, ids, taskId) {
        const id = String(h.id || '');
        if (ids.has('ph_refund_' + id)) return true;
        return id.startsWith('ph_auto_') && ids.has('ph_refund_' + taskId);
    }

    /**
     * Missing deterministic ladder rows for a task.
     * Ids: ph_pen1_<taskId>_<dueMs>, ph_pen2_<taskId>_<dueMs> (the due suffix makes a re-late after a due-date
     * edit chargeable again). Rows carry `dueMs`. Legacy ids ph_pen1_<taskId> (no suffix, same due), ph_auto_*
     * (with or without taskId field) count as an existing charge unless refunded.
     * SWEEP CONTRACT: for a completed task the ladder is fixed by its completedAt (the `at` argument is ignored
     * when task.completed && task.completedAt is valid), so a device that never saw the completion can only
     * mint rows the merge/heal later voids with a deterministic refund row.
     * DATE RULE (deterministic per id): date = ladder time (due, due+24h) if that is inside the week window of
     * the minting call (opts.now, default `at`); otherwise (catch-up of a closed window) date = that window start,
     * flagged catchUp:true, so the minus shows in the week it was charged. Same id from several devices merges to
     * the earliest date (mergePointsHistory).
     * @param {object} task @param {number|string|Date} at now (uncompleted) or completedAt
     * @param {Array} existingLedger @param {Array} [subjects] @param {{notBefore?:number, now?:number}} [opts]
     * @returns {Array} new ledger rows (points -1 each)
     */
    function penaltyRowsFor(task, at, existingLedger, subjects, opts) {
        if (!task || !task.id) return [];
        const doneMs = task.completed ? toMs(task.completedAt) : NaN;
        const ref = Number.isFinite(doneMs) ? doneMs : at;
        const ev = evaluateLateness(task, ref, ref);
        if (ev.step === 0) return [];
        const due = getDueMs(task);
        if (opts && opts.notBefore && due < opts.notBefore) return [];
        const mintNow = opts && opts.now !== undefined ? toMs(opts.now) : toMs(at);
        const winStart = getWindowStart(mintNow);
        const ledger = Array.isArray(existingLedger) ? existingLedger : [];
        const idx = ledgerIndex(ledger);
        const ids = opts && opts.ids ? opts.ids : idx.ids;
        const ownIds = !!(opts && opts.ids); // only a caller-owned set is written to (the cached one mirrors the array)
        const minted = new Set();
        const mine = idx.byTask.get(task.id) || [];
        const sub = (subjects || []).find((s) => s && s.id === task.subjectId);
        const common = {
            taskId: task.id,
            taskTitle: task.title,
            subjectName: sub ? sub.name : 'כללי',
            subjectEmoji: sub ? sub.emoji : '📚',
            points: -1,
            dueMs: due,
        };
        const step1Broken = !!(opts && opts.alreadyBrokenByTaskIds && opts.alreadyBrokenByTaskIds.has(task.id));
        const rows = [];
        for (let step = 1; step <= ev.step; step++) {
            const id = `ph_pen${step}_${task.id}_${due}`;
            if (ids.has(id) || minted.has(id)) continue;
            // same due written under another timezone's instant (older builds): variant of this charge
            if (mine.some((h) => h && h.taskId === task.id && rowStep(h) === step && isDueVariant(rowDueMs(h), due) && !isRefunded(h, ids, task.id))) continue;
            const legacyId = `ph_pen${step}_${task.id}`;
            const legacy = mine.find((h) => h && String(h.id) === legacyId && msOr0(h.date) === due + (step - 1) * DAY_MS);
            if (legacy && !isRefunded(legacy, ids, task.id)) continue;
            // legacy ph_auto_* (covered both steps with -2) blocks while not refunded
            if (mine.some((h) => h && String(h.id || '').startsWith('ph_auto_') && rowBelongsTo(h, task.id) && !isRefunded(h, ids, task.id))) continue;
            const ladderMs = due + (step - 1) * DAY_MS;
            const late = ladderMs < winStart;
            minted.add(id);
            if (ownIds) ids.add(id);
            rows.push({
                id, ...common,
                date: new Date(late ? winStart : ladderMs).toISOString(),
                ...(late ? { catchUp: true } : {}),
                ...(step === 1 && step1Broken ? { streakAlreadyBroken: true } : {}),
                details: step === 1 ? 'קנס אוטומטי! המשימה עברה את זמן ההגשה (-1) והרצף נשבר.' : 'קנס נוסף! עברו 24 שעות מזמן ההגשה (-1).',
            });
        }
        return rows;
    }

    /** Refund rows (id ph_refund_<penId>, positive) for un-refunded penalties of the task (optionally only step>=minStep). Penalty rows stay. */
    /** Task ids whose streak break is already recorded (streakHistory brokenByTaskId): do not break twice. */
    function alreadyBrokenIds(user) {
        return new Set((user && Array.isArray(user.streakHistory) ? user.streakHistory : []).filter((r) => r && r.brokenByTaskId).map((r) => r.brokenByTaskId));
    }
    function hasStreakBreakFor(user, taskId) { return alreadyBrokenIds(user).has(taskId); }

    /**
     * Un-complete helper: refund ONLY completion rows of the task (positive, not ph_pen*, not refunds, not the
     * opening balance, not canceled): ph_<id>, ph_healed_*, grade/manual rows. Rows stay; refund id ph_refund_<rowId>.
     */
    function refundCompletionRowsOnly(ledger, taskId, dateIso) {
        const hist = Array.isArray(ledger) ? ledger : [];
        const ids = ledgerIdSet(hist);
        const rows = [];
        for (const h of hist) {
            if (!h || h.canceled || !rowBelongsTo(h, taskId) || !((Number(h.points) || 0) > 0)) continue;
            const id = String(h.id || '');
            if (!id || id.startsWith('ph_pen') || id.startsWith('ph_refund_') || id.startsWith('ph_auto_') || id === OPENING_ID) continue;
            const rid = 'ph_refund_' + id;
            if (ids.has(rid)) continue;
            ids.add(rid);
            const d = Math.max(msOr0(dateIso), msOr0(h.date));
            rows.push({ id: rid, taskId, taskTitle: h.taskTitle || '', subjectName: h.subjectName || '', subjectEmoji: h.subjectEmoji || '',
                points: -Math.abs(h.points), date: new Date(d || Date.now()).toISOString(), details: 'ביטול נקודות: ההגשה בוטלה' });
        }
        return rows;
    }

    /**
     * Refund penalty rows that no longer apply at `now` (due moved, task no longer overdue): all penalties when not
     * overdue, otherwise only steps above the current ladder step. Rows stay; deterministic ph_refund_<penId>.
     */
    function refundPenaltiesIfNotOverdue(task, ledger, now) {
        if (!task || !task.id) return [];
        const ev = evaluateLateness(task, null, now);
        const stepOf = (h) => rowStep(h);
        const only = ev.step === 0 ? null : (h) => stepOf(h) > ev.step;
        return refundRowsFor(task.id, ledger, new Date(msOr0(now) || Date.now()).toISOString(), 'החזר קנס: המשימה אינה באיחור', only);
    }

    function refundRowsFor(taskId, ledger, dateIso, details, onlyIds, idSet) {
        const hist = Array.isArray(ledger) ? ledger : [];
        const idx = ledgerIndex(hist);
        const ids = idSet || idx.ids;
        const minted = new Set();
        const rows = [];
        for (const h of idx.byTask.get(taskId) || []) {
            if (!h || !rowBelongsTo(h, taskId) || !isPenaltyRow(h)) continue;
            if (onlyIds && !onlyIds(h)) continue;
            const rid = 'ph_refund_' + h.id;
            if (ids.has(rid) || minted.has(rid)) continue;
            if (String(h.id).startsWith('ph_auto_') && ids.has('ph_refund_' + taskId)) continue; // legacy refund
            // refund never lands in an earlier week than the penalty it cancels
            const d = Math.max(msOr0(dateIso), msOr0(h.date));
            minted.add(rid);
            if (idSet) ids.add(rid);
            rows.push({
                id: rid, taskId, taskTitle: h.taskTitle || '', subjectName: h.subjectName || '', subjectEmoji: h.subjectEmoji || '',
                points: Math.abs(h.points), date: d ? new Date(d).toISOString() : dateIso, details: details || 'החזר קנס אוטומטי',
            });
        }
        return rows;
    }

    const OPENING_ID = 'ph_opening_balance';
    const OPENING_MAX_ROWS = 3;
    /**
     * Legacy stored totalPoints above the ledger sum (non-empty ledger) become ONE permanent row
     * ph_opening_balance dated 2020-01-01 (outside every window). Never created twice, never negative.
     * Merge keeps the smaller amount on conflict, so no device can invent points.
     */
    function ensureOpeningBalance(user) {
        const hist = Array.isArray(user.pointsHistory) ? user.pointsHistory : [];
        if (!hist.length || hist.some((h) => h && h.id === OPENING_ID)) return user;
        // A real ledger is the authority: a stored total above it is a stale/phantom cache (owner complaint: headline jumped to 200+
        // while the ledger said 189), never points to mint. Only a sparse ledger (<= OPENING_MAX_ROWS) can sit on a legacy total.
        if (hist.length > OPENING_MAX_ROWS) return user;
        const stored = Number(user.totalPoints) || 0;
        // ladder rows (ph_pen*) and their refunds are newer than any stored total: leave them out of the comparison
        const legacyRows = hist.filter((h) => !(h && (String(h.id || '').startsWith('ph_pen') || String(h.id || '').startsWith('ph_refund_ph_pen'))));
        const diff = stored - sumLedger(legacyRows, {});
        if (!(stored > 0)) return user;
        if (!(diff > 0)) return user;
        return { ...user, pointsHistory: [...hist, { id: OPENING_ID, taskId: null, taskTitle: '', subjectName: '', subjectEmoji: '', points: diff, date: '2020-01-01T00:00:00.000Z', details: 'יתרת פתיחה (נקודות שנצברו לפני יומן הנקודות)' }] };
    }

    /** Drop ph_healed_<taskId> rows when a real positive completion row exists for the task (order independent). */
    function dedupeHealed(hist) {
        const real = new Set();
        for (const h of hist) {
            if (h && h.taskId && (h.points || 0) > 0 && !isAutoHistoryId(h.id) && !String(h.id || '').startsWith('ph_healed_') && h.id !== OPENING_ID) real.add(h.taskId);
        }
        const out = hist.filter((h) => !(h && String(h.id || '').startsWith('ph_healed_') && real.has(h.taskId)));
        return out.length === hist.length ? hist : out;
    }

    // ---- live-repo hotfixes (v20261113_7..9), kept deliberately -------------------------------------------------
    // Rows of the 2026-11-13 bug (bogus completions of two 11.11.26 tasks, history subject, CS rows at 01:20) are dropped
    // from the ledger on every merge/heal (live behavior). The history-subject rule is bounded to rows dated before the
    // hotfix deploy so legitimate later history study is not purged forever.
    const HOTFIX_CUTOFF_MS = Date.parse('2026-11-13T00:41:00.000Z');
    const LOCKED_TASK_IDS = new Set(['t_1794473104904', 't_1794473352381']);
    function isInvalidPointsHistory(p) {
        if (!p) return true;
        const sub = String(p.subjectName || '');
        const id = String(p.id || '');
        const dt = String(p.date || '');
        const taskId = String(p.taskId || '');
        const title = String(p.taskTitle || '');
        if (sub.includes('היסטוריה')) { const ms = toMs(p.date); if (!Number.isFinite(ms) || ms < HOTFIX_CUTOFF_MS) return true; }
        if (id.includes('1794473352381') || taskId === 't_1794473352381' || (title.includes('11.11.26') && sub.includes('פיזיקה'))) return true;
        if (id.includes('1794473104904') || taskId === 't_1794473104904' || (title.includes('11.11.26') && sub.includes('מתמטיקה'))) return true;
        if (id.startsWith('ph_t_1794521101639_') || (dt.startsWith('2026-11-13T01:20') && sub.includes('מדעי המחשב'))) return true;
        return false;
    }
    /** The two locked tasks stay uncompleted unless genuinely submitted after the hotfix. */
    function lockBogusCompletion(t) {
        if (!t || !LOCKED_TASK_IDS.has(t.id)) return t;
        if (!(t.completed || t.completedAt || t.pointsEarned)) return t;
        const ms = toMs(t.completedAt);
        if (Number.isFinite(ms) && ms >= HOTFIX_CUTOFF_MS) return t;
        const out = { ...t, completed: false, completedAt: null, pointsEarned: null };
        return out;
    }
    function isTestTask(t) {
        if (!t) return false;
        if (String(t.id || '').startsWith('t_live_verify_')) return true;
        return !!(t.title && (String(t.title).includes('לבדיקת סנכרון חי') || String(t.title).includes('בדיקת סנכרון')));
    }
    function mergeSubjects(localSubs, remoteSubs, deletedSubjectIds) {
        const del = new Set(Array.isArray(deletedSubjectIds) ? deletedSubjectIds : []);
        const byId = new Map();
        for (const raw of [...(Array.isArray(remoteSubs) ? remoteSubs : []), ...(Array.isArray(localSubs) ? localSubs : [])]) {
            const sb = withId(raw);
            if (!sb || del.has(sb.id)) continue;
            const e = byId.get(sb.id);
            if (!e) { byId.set(sb.id, sb); continue; }
            const ue = msOr0(e.updatedAt || e.lastModified), us = msOr0(sb.updatedAt || sb.lastModified);
            const sbWins = ue !== us ? us > ue : cmpDet(e, sb) < 0;
            byId.set(sb.id, sbWins ? { ...e, ...sb } : { ...sb, ...e });
        }
        return Array.from(byId.values()).sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    }

    function taskLooksCompleted(task, pointsHistory) {
        if (!task) return false;
        if (task.completed || task.givenUp || task.completedAt) return true;
        // explicit un-complete marker beats ledger evidence
        if (task.uncompletedAt) return false;
        const hist = pointsHistory || [];
        return hist.some(
            (h) =>
                h.taskId === task.id &&
                h.id &&
                !isAutoHistoryId(h.id)
        );
    }

    function isTaskSubmittedOnTime(task) {
        if (!task || !task.completedAt) return false;
        if (isExemptTask(task) || !task.dueDate) return true;
        const subDate = new Date(msOr0(task.completedAt) || NaN);
        if (isNaN(subDate.getTime()) || isNaN(getDueMs(task))) return false;
        return !evaluateLateness(task, subDate.getTime(), null).late;
    }

    // ---------------------------------------------------------------- streak
    /** Valid streak start: not null, finite, year >= 2020 (rejects the 1970 epoch from new Date(null)). */
    function isValidStart(d) {
        if (isNil(d) || d === '') return false;
        const ms = toMs(d);
        return Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= 2020;
    }

    /**
     * Does this completed task advance taskStreak? Mirrors app.jsx handleCompleteTask/practice/lesson paths:
     * practice, flexible-exam, reward and exam-prep tasks advance it (streakBroken=false) when submitted;
     * lesson logs never touch the streak; given-up tasks do not; a late submit breaks instead of advancing.
     */
    function advancesStreak(t) {
        if (!t || !t.completed || t.givenUp || t.isLessonLog) return false;
        const ms = toMs(t.completedAt);
        if (!Number.isFinite(ms)) return false;
        return !evaluateLateness(t, ms, null).late;
    }

    /**
     * Start of a streak of `length` ending before endMs: completedAt of the length-th most recent task that
     * advanced the streak (advancesStreak) strictly before endMs. null if underivable.
     */
    function deriveStreakStart(tasks, length, endMs) {
        const L = Number(length) || 0;
        if (L <= 0) return null;
        const end = Number.isFinite(endMs) ? endMs : Infinity;
        const counted = (Array.isArray(tasks) ? tasks : [])
            .filter((t) => advancesStreak(t) && toMs(t.completedAt) < end)
            .map((t) => toMs(t.completedAt))
            .sort((a, b) => b - a);
        if (counted.length < L) return null;
        return new Date(counted[L - 1]).toISOString();
    }

    /** If taskStreak > 0 and currentStreakStart is invalid, set it (derived from tasks, else fallbackIso/now). */
    function ensureStreakStart(user, fallbackIso) {
        if (!user || !((Number(user.taskStreak) || 0) > 0) || isValidStart(user.currentStreakStart)) return user;
        const start = deriveStreakStart(user.tasks, user.taskStreak, Infinity) || fallbackIso || null;
        if (start === null) return user;
        return { ...user, currentStreakStart: start };
    }

    /**
     * Idempotent repair of invalid streak start dates: for each streakHistory record with an invalid startDate
     * derive it from completed tasks (see deriveStreakStart); current streak start likewise. Underivable stays null.
     * Returns the same reference when nothing changes.
     */
    function repairStreakDates(user) {
        if (!user) return user;
        let changed = false;
        const hist = (Array.isArray(user.streakHistory) ? user.streakHistory : []).map((r) => {
            if (!r || isValidStart(r.startDate) || !isValidStart(r.endDate) || !((Number(r.length) || 0) > 0)) return r;
            const d = deriveStreakStart(user.tasks, r.length, toMs(r.endDate));
            if (!d) return r;
            changed = true;
            return { ...r, startDate: d };
        });
        let cur = user.currentStreakStart;
        if ((Number(user.taskStreak) || 0) > 0 && !isValidStart(cur)) {
            const d = deriveStreakStart(user.tasks, user.taskStreak, Infinity);
            if (d) { cur = d; changed = true; }
        }
        if (!changed) return user;
        return { ...user, streakHistory: hist, currentStreakStart: cur };
    }

    // Who wins field-level conflicts between two copies of the same record:
    // both stamped with different updatedAt -> newer stamp; else the doc edited last (ctx.syncCmp, from lastSync);
    // else deterministic content order (so merge is commutative). ctx.syncCmp = sign(incomingSync - localSync).
    function incomingWins(localT, incomingT, ctx) {
        const mL = msOr0(localT.updatedAt || localT.lastModified);
        const mR = msOr0(incomingT.updatedAt || incomingT.lastModified);
        if (mL && mR) return mL !== mR ? mR > mL : cmpDet(localT, incomingT) < 0; // equal stamps: content, never lastSync
        const sc = ctx && ctx.syncCmp ? ctx.syncCmp : 0;
        if (sc !== 0) return sc > 0;
        return cmpDet(localT, incomingT) < 0;
    }
    // Winner copy: a stamped winner is taken wholesale (so a field it deleted stays deleted); an unstamped
    // winner is layered over the loser (we cannot tell deletion from "never had it").
    function combine(loser, winner) {
        const stamped = msOr0(winner.updatedAt || winner.lastModified) > 0;
        return stamped ? { ...winner } : { ...loser, ...winner };
    }
    function overlay(loser, winner) {
        const out = combine(loser, winner);
        const u = Math.max(msOr0(loser.updatedAt), msOr0(winner.updatedAt));
        if (u) out.updatedAt = u;
        return out;
    }
    function doneFix(t) {
        return { ...t, completed: true, autoPenaltyApplied: isTaskSubmittedOnTime(t) ? false : (t.autoPenaltyApplied || false) };
    }
    const DONE_FIELDS = ['completed', 'completedAt', 'pointsEarned', 'autoPenaltyApplied', 'givenUp', 'understandingRating'];
    function isUncompleted(t) { return !!(t && t.uncompletedAt && !t.completed && !t.completedAt); }
    function isDoneRaw(t) { return !!(t && (t.completed || t.givenUp || t.completedAt)); }

    /**
     * Un-complete contract (UI): set completed:false, delete completedAt, uncompletedAt = Date.now(),
     * updatedAt = Date.now(), and cancel the ledger rows of that completion by explicit deterministic refund rows
     * (ph_refund_<rowId>) - never delete rows. A completion with completedAt <= max(uncompletedAt) loses.
     */
    function mergeTaskPairCore(localT, incomingT, pointsHistory, ctx) {
        if (!localT) return taskLooksCompleted(incomingT, pointsHistory) ? doneFix(incomingT) : incomingT;
        if (!incomingT) return taskLooksCompleted(localT, pointsHistory) ? doneFix(localT) : localT;
        const fieldsIncoming = incomingWins(localT, incomingT, ctx);
        const sides = [localT, incomingT];
        // un-complete beats a completion that is not newer than the (max) un-complete stamp
        const marked = sides.filter(isUncompleted);
        if (marked.length) {
            const U = Math.max(...marked.map((t) => msOr0(t.uncompletedAt)));
            const doneMs = sides.filter(isDoneRaw).map((t) => msOr0(t.completedAt));
            if (!doneMs.length || U >= Math.max(...doneMs)) {
                const out = fieldsIncoming ? overlay(localT, incomingT) : overlay(incomingT, localT);
                delete out.completedAt;
                out.completed = false;
                out.uncompletedAt = U;
                return out;
            }
        }
        const localDone = taskLooksCompleted(localT, pointsHistory);
        const incomingDone = taskLooksCompleted(incomingT, pointsHistory);
        if (localDone !== incomingDone) {
            const doneSide = localDone ? localT : incomingT;
            const out = fieldsIncoming ? overlay(localT, incomingT) : overlay(incomingT, localT);
            for (const k of DONE_FIELDS) { if (k in doneSide) out[k] = doneSide[k]; }
            return doneFix(out);
        }
        if (localDone && incomingDone) {
            const lp = localT.pointsEarned || 0, ip = incomingT.pointsEarned || 0;
            const preferIncoming = lp !== ip ? ip > lp : fieldsIncoming;
            const out = preferIncoming ? overlay(localT, incomingT) : overlay(incomingT, localT);
            const onTime = isTaskSubmittedOnTime(out) || isTaskSubmittedOnTime(localT) || isTaskSubmittedOnTime(incomingT);
            return { ...out, completed: true, autoPenaltyApplied: onTime ? false : (out.autoPenaltyApplied || false) };
        }
        return fieldsIncoming ? overlay(localT, incomingT) : overlay(incomingT, localT);
    }

    // autoPenaltyApplied merges as OR (monotone true; an old snapshot must not flip it back), except a task that
    // turned out on time (doneFix). Sweep output must NOT bump task updatedAt (a flag-only change must not win
    // field conflicts); the UI sweep caller sets autoPenaltyApplied without touching updatedAt.
    function mergeTaskPair(localT, incomingT, pointsHistory, ctx) {
        const res = lockBogusCompletion(mergeTaskPairCore(localT, incomingT, pointsHistory, ctx));
        if (!localT || !incomingT || !res || (!localT.autoPenaltyApplied && !incomingT.autoPenaltyApplied)) return res;
        if (isTaskSubmittedOnTime(res)) return res;
        // S7: the flag may only be (re)set to true when the task is currently overdue AND a non-refunded penalty row
        // exists; a stale snapshot must not flip it back on after a due-date edit refunded the penalties.
        const hist = Array.isArray(pointsHistory) ? pointsHistory : [];
        const idx = ledgerIndex(hist);
        const overdue = evaluateLateness(res, res.completed ? res.completedAt : null, ctx && ctx.now !== undefined ? ctx.now : Date.now()).late;
        const activePen = (idx.byTask.get(res.id) || []).some((h) => isPenaltyRow(h) && !isRefunded(h, idx.ids, res.id));
        if (!(overdue && activePen)) return res;
        const aL = !!localT.autoPenaltyApplied, aR = !!incomingT.autoPenaltyApplied;
        const v = aL || aR; // monotone OR (M7); only a task that turned out on time clears it (doneFix)
        return res.autoPenaltyApplied === v ? res : { ...res, autoPenaltyApplied: v };
    }

    /** Deterministic id for id-less records (content derived). */
    function withId(t) {
        if (!t || typeof t !== 'object') return null;
        return t.id ? t : { ...t, id: 'tx_' + contentHash(t) };
    }

    /** Ids assigned to id-less tasks, duplicate ids collapsed by newer updatedAt. */
    function normalizeTasks(list, pointsHistory) {
        const byId = new Map();
        for (const raw of Array.isArray(list) ? list : []) {
            const t = withId(raw);
            if (!t) continue;
            byId.set(t.id, byId.has(t.id) ? mergeTaskPair(byId.get(t.id), t, pointsHistory, { syncCmp: 0 }) : t);
        }
        return Array.from(byId.values());
    }

    function mergeExams(localExams, remoteExams, deletedExamIds, ctx) {
        const deleted = new Set(Array.isArray(deletedExamIds) ? deletedExamIds : []);
        const norm = (l) => normalizeTasks(l, []).filter(e => !deleted.has(e.id));
        const byId = new Map();
        for (const e of norm(localExams)) byId.set(e.id, e);
        for (const r of norm(remoteExams)) {
            const e = byId.get(r.id);
            byId.set(r.id, e ? (incomingWins(e, r, ctx) ? overlay(e, r) : overlay(r, e)) : r);
        }
        return Array.from(byId.values());
    }

    function mergeTasks(localTasks, incomingTasks, pointsHistory, deletedTaskIds = [], ctx) {
        const deletedSet = new Set(Array.isArray(deletedTaskIds) ? deletedTaskIds : []);
        const local = normalizeTasks(localTasks, pointsHistory).filter(t => !deletedSet.has(t.id) && !isTestTask(t));
        const incoming = normalizeTasks(incomingTasks, pointsHistory).filter(t => !deletedSet.has(t.id) && !isTestTask(t));
        const byId = new Map();
        for (const t of local) byId.set(t.id, t);
        for (const t of incoming) byId.set(t.id, mergeTaskPair(byId.get(t.id), t, pointsHistory, ctx));
        // normalise one-sided tasks the same way as merged ones (keeps merge commutative)
        return Array.from(byId.values()).map(t => lockBogusCompletion(taskLooksCompleted(t, pointsHistory) ? doneFix(t) : t));
    }

    function normalizeBadge(b) {
        if (!b) return null;
        if (typeof b === 'string') return { id: b, earnedAt: new Date().toISOString() };
        if (b && b.id) return b;
        return null;
    }

    function mergeBadges(localBadges, remoteBadges, local, remote) {
        const listA = (Array.isArray(localBadges) ? localBadges : []).map(normalizeBadge).filter(Boolean);
        const listB = (Array.isArray(remoteBadges) ? remoteBadges : []).map(normalizeBadge).filter(Boolean);
        const map = new Map();
        [...listB, ...listA].forEach(b => {
            const existing = map.get(b.id);
            if (!existing) {
                map.set(b.id, b);
            } else {
                if (b.id === 'b_weekly_champ') {
                    const wA = Array.isArray(existing.wonWeeks) ? existing.wonWeeks : [];
                    const wB = Array.isArray(b.wonWeeks) ? b.wonWeeks : [];
                    let mergedWeeks = Array.from(new Set([...wA, ...wB]));
                    const isUserShely = (local && (local.username === 'שליי' || local.name === 'שלי')) || (remote && (remote.username === 'שליי' || remote.name === 'שלי'));
                    if (isUserShely) mergedWeeks = mergedWeeks.filter(w => w !== '2026-W45');
                    const safeCount = mergedWeeks.length > 0 ? mergedWeeks.length : Math.max(existing.count || 1, b.count || 1);
                    map.set(b.id, {
                        ...existing,
                        ...b,
                        wonWeeks: mergedWeeks,
                        count: safeCount,
                        lastWonWeek: mergedWeeks.length > 0 ? mergedWeeks[mergedWeeks.length - 1] : (b.lastWonWeek || existing.lastWonWeek)
                    });
                } else {
                    map.set(b.id, {
                        ...existing,
                        ...b,
                        count: Math.max(existing.count || 1, b.count || 1)
                    });
                }
            }
        });
        return Array.from(map.values());
    }

    const OUTBOX_KEY_PREFIX = 'studyStreak_outbox_';

    function markPendingSync(username, data) {
        if (!username || typeof localStorage === 'undefined') return;
        try {
            const outboxItem = {
                username,
                timestamp: Date.now(),
                data: data
            };
            localStorage.setItem(OUTBOX_KEY_PREFIX + username, JSON.stringify(outboxItem));
        } catch (e) {
            console.warn('Could not write to sync outbox:', e);
        }
    }

    function getPendingSync(username) {
        if (!username || typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(OUTBOX_KEY_PREFIX + username);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function clearPendingSync(username) {
        if (!username || typeof localStorage === 'undefined') return;
        try {
            localStorage.removeItem(OUTBOX_KEY_PREFIX + username);
        } catch (e) {}
    }

    // Field-wise record merge: null/undefined/invalid never overwrite a real value; canceled is sticky;
    // dates: start = earliest valid, end = latest valid; other conflicts resolve deterministically.
    function mergeRecord(x, y, dateKeys) {
        const out = { ...x };
        for (const k of Object.keys(y)) {
            const v = y[k];
            const cur = out[k];
            if (dateKeys && dateKeys[k]) {
                const okV = isValidStart(v), okC = isValidStart(cur);
                if (!okV) { if (!okC && isNil(cur) && !isNil(v)) out[k] = v; continue; }
                if (!okC) { out[k] = v; continue; }
                const mv = toMs(v), mc = toMs(cur);
                out[k] = dateKeys[k] === 'min' ? (mv < mc ? v : cur) : (mv > mc ? v : cur);
                continue;
            }
            if (k === 'canceled') { out[k] = !!(cur || v); continue; }
            if (isNil(v)) continue;
            if (isNil(cur)) { out[k] = v; continue; }
            if (stableStringify(cur) !== stableStringify(v)) out[k] = cmpDet(cur, v) >= 0 ? cur : v;
        }
        return out;
    }
    function sortRecords(list, dateKey) {
        return list.sort((a, b) => {
            const d = msOr0(b[dateKey]) - msOr0(a[dateKey]);
            if (d) return d;
            return String(a.id || '') < String(b.id || '') ? -1 : String(a.id || '') > String(b.id || '') ? 1 : cmpDet(a, b);
        });
    }

    function mergeStreakHistoryOLD(localStreaks, remoteStreaks) {
        const listA = Array.isArray(localStreaks) ? localStreaks : [];
        const listB = Array.isArray(remoteStreaks) ? remoteStreaks : [];
        const dk = { startDate: 'min', endDate: 'max' };
        const map = new Map();
        for (const item of [...listB, ...listA]) {
            if (!item || item.id === 'sh_september_baseline') continue; // dummy seeded baseline (live repo)
            // one record per breaking task (live repo: deduplicate streak history), else by id, else by dates
            const key = item.brokenByTaskId ? 'broken_' + item.brokenByTaskId : (item.id ? String(item.id) : (item.startDate && item.endDate ? `${item.startDate}_${item.endDate}` : null));
            if (!key) continue;
            map.set(key, map.has(key) ? mergeRecord(map.get(key), item, dk) : item);
        }
        return sortRecords(Array.from(map.values()), 'endDate');
    }

    // Same-id ledger conflict, order independent: penalties keep the negative (smaller points), refunds the
    // positive (larger), opening balance the smaller amount, otherwise newer updatedAt, else deterministic content order.
    // canceled is sticky; penalty dates keep the earliest copy (see penaltyRowsFor DATE RULE).
    function mergeLedgerRow(x, y) {
        const id = String(x.id || '');
        const px = Number(x.points), py = Number(y.points);
        const both = Number.isFinite(px) && Number.isFinite(py) && px !== py;
        let points; // authority rule for points; undefined = decided per key like every other field
        if (both && (id.startsWith('ph_pen') || id.startsWith('ph_auto_') || id === OPENING_ID)) points = Math.min(px, py);
        else if (both && id.startsWith('ph_refund_')) points = Math.max(px, py);
        const ux = msOr0(x.updatedAt), uy = msOr0(y.updatedAt);
        // Per-key pick (associative): only one side has it -> that; equal -> same; else newer updatedAt, else canonical
        // content order. Cosmetic fields (taskTitle, subjectName, details) resolve the same way on every merge order.
        // Per-key stamps (`kts`, only where a value's stamp is older than the row's updatedAt) keep the winner of an
        // optional key independent of merge grouping: the value from the greatest stamp among rows that HAVE it.
        const out = {};
        const kts = {};
        const ustamp = Math.max(ux, uy);
        const stampOf = (row, u, k) => (row.kts && row.kts[k] !== undefined ? msOr0(row.kts[k]) : u);
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
            if (k === 'kts') continue;
            const inX = x[k] !== undefined, inY = y[k] !== undefined; // undefined counts as absent
            if (!inX && !inY) continue;
            const sx = stampOf(x, ux, k), sy = stampOf(y, uy, k);
            let v, st;
            if (!inY) { v = x[k]; st = sx; }
            else if (!inX) { v = y[k]; st = sy; }
            else if (stableStringify(x[k]) === stableStringify(y[k])) { v = x[k]; st = Math.max(sx, sy); }
            else if (sx !== sy) { v = sx > sy ? x[k] : y[k]; st = Math.max(sx, sy); }
            else { v = cmpDet(x[k], y[k]) >= 0 ? x[k] : y[k]; st = sx; }
            out[k] = v;
            if (k !== 'updatedAt' && st !== ustamp) kts[k] = st;
        }
        if (Object.keys(kts).length) out.kts = kts;
        if (points !== undefined) out.points = points;
        if (x.canceled || y.canceled) out.canceled = true;
        if (id.startsWith('ph_pen')) {
            const dx = toMs(x.date), dy = toMs(y.date);
            if (Number.isFinite(dx) && Number.isFinite(dy)) {
                // earliest date wins; catchUp follows the winning copy, equal dates need both (associative)
                const src = dx < dy ? x : dy < dx ? y : null;
                out.date = (src || x).date;
                const cu = src ? !!src.catchUp : !!(x.catchUp && y.catchUp);
                if (cu) out.catchUp = true; else delete out.catchUp;
            }
        }
        return out;
    }

    function ledgerKey(item) {
        if (item.id) return String(item.id);
        if (item.taskId && item.date) return `${item.taskId}_${stableStringify(item.date)}`;
        return 'h_' + contentHash(item);
    }

    /**
     * Penalty rows for the same task+step whose due instants are the same wall-clock due read in different
     * host timezones (older builds) collapse to one: the canonical (Asia/Jerusalem) id if present, else the
     * smallest id. Their refund rows go with them. Pure function of the merged ledger + tasks.
     */
    function dedupePenaltyVariants(hist, tasks) {
        const drop = new Set();
        for (const t of Array.isArray(tasks) ? tasks : []) {
            if (!t || !t.id) continue;
            const due = getDueMs(t);
            if (!Number.isFinite(due)) continue;
            for (const step of [1, 2]) {
                const group = hist.filter((h) => h && h.taskId === t.id && rowStep(h) === step && (rowDueMs(h) === due || isDueVariant(rowDueMs(h), due)));
                if (group.length < 2) continue;
                const canon0 = `ph_pen${step}_${t.id}_${due}`;
                const keep = group.find((h) => h.id === canon0) || group.slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))[0];
                for (const h of group) if (h !== keep) { drop.add(String(h.id)); drop.add('ph_refund_' + h.id); }
            }
        }
        if (!drop.size) return hist;
        return hist.filter((h) => !(h && drop.has(String(h.id))));
    }

    function mergePointsHistory(localHist, remoteHist) {
        const listA = (Array.isArray(localHist) ? localHist : []).filter(h => !(h && typeof h === 'object' && isInvalidPointsHistory(h)));
        const listB = (Array.isArray(remoteHist) ? remoteHist : []).filter(h => !(h && typeof h === 'object' && isInvalidPointsHistory(h)));
        const map = new Map();
        for (const item of [...listB, ...listA]) {
            if (!item || typeof item !== 'object') continue;
            const key = ledgerKey(item);
            map.set(key, map.has(key) ? mergeLedgerRow(map.get(key), item) : item);
        }
        return sortRecords(Array.from(map.values()), 'date');
    }

    /** Streak records, minus those whose broken-record id was already restored (restoredBrokenIds tombstones). */
    function mergeStreakHistory(localStreaks, remoteStreaks, restoredIds) {
        const restored = new Set(Array.isArray(restoredIds) ? restoredIds : []);
        return mergeStreakHistoryOLD(localStreaks, remoteStreaks).filter((r) => !(r && r.id && restored.has(r.id)));
    }

    function verifyAndRepairStreakAndTasks(user) {
        if (!user || !Array.isArray(user.tasks)) return user;
        const hist = Array.isArray(user.pointsHistory) ? user.pointsHistory : [];
        let changed = false;
        let tasks = [...user.tasks];
        let taskStreak = user.taskStreak;
        let longestStreak = user.longestStreak || 0;

        tasks = tasks.map(t => {
            if (!t) return t;
            if (!t.completed && taskLooksCompleted(t, hist)) {
                changed = true;
                return { ...t, completed: true, autoPenaltyApplied: isTaskSubmittedOnTime(t) ? false : (t.autoPenaltyApplied || false) };
            }
            return t;
        });

        if ((taskStreak === 0 || taskStreak === undefined) && longestStreak > 0) {
            const hasActiveBreak = Array.isArray(user.streakHistory) && user.streakHistory.length > 0;
            if (!hasActiveBreak) {
                taskStreak = longestStreak;
                changed = true;
            }
        }

        if (!changed) return user;
        return ensureStreakStart({
            ...user,
            tasks,
            taskStreak: taskStreak !== undefined ? taskStreak : (user.taskStreak || 0),
            longestStreak: Math.max(longestStreak, taskStreak || 0)
        });
    }

    const MANAGED_KEYS = new Set([
        'tasks', 'pointsHistory', 'streakHistory', 'badges', 'exams', 'subjects', 'deletedSubjectIds', 'deletedTaskIds', 'deletedExamIds', 'restoredBrokenIds', 'penaltyLadderStartedAt',
        'taskStreak', 'longestStreak', 'currentStreakStart', 'currentStreakEmojis', 'totalPoints', 'weeklyPoints',
        'lastCrownedWeekEnd', 'crownedWeekPoints', 'nextWeeklyCrowning', 'nextWeeklyReset',
        'lastWeeklyReportSentWeek', 'lastWeeklyReportSentTime', 'lastGlobalWhatsAppReminderSent', 'lastSync', 'fieldUpdatedAt',
    ]);
    // Mirror of the non-dynamic fields of DEFAULT_USER_STATE (js/helpers.js; a test keeps them in sync).
    const DEFAULT_USER_FIELDS = {
        password: '', name: 'תלמיד/ה', highestWeeklyPoints: 0, subjects: [],
        scheduleSettings: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, schoolEndTime: '', anchors: [] })),
        friends: [], phoneNumber: '', parentPhoneNumber: '', parentPhoneNumber2: '',
        whatsappGateway: { instanceId: '', apiToken: '', host: 'https://api.green-api.com' },
        autoSendParentReport: true, sendReportToPrimaryParentOnly: false, lastTaskRemindersSent: {}, notifications: [],
    };
    /**
     * Is `value` the untouched default for this user field? nil always counts; a key with a known default must equal it (so
     * autoSendParentReport:false is NOT default); unknown keys: '', 0, false, [], {}. Provenance rule: a default value never beats a non-default one.
     */
    function isDefaultValue(key, value) {
        if (value === null || value === undefined) return true;
        if (Object.prototype.hasOwnProperty.call(DEFAULT_USER_FIELDS, key)) return stableStringify(value) === stableStringify(DEFAULT_USER_FIELDS[key]);
        if (value === '' || value === 0 || value === false) return true;
        if (Array.isArray(value) && !value.length) return true;
        if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return true;
        return false;
    }
    const ARRAY_KEYS = ['tasks', 'pointsHistory', 'streakHistory', 'badges', 'exams', 'deletedTaskIds', 'deletedExamIds', 'restoredBrokenIds', 'currentStreakEmojis'];
    const META_KEYS = new Set(['username', 'name', 'id', 'lastSync', 'fieldUpdatedAt']);
    const MERGE_ABORTED = 'aborted';
    const STAMP_SKEW_MS = 5 * 60 * 1000;

    /** True when mergeUserData refused to merge: the caller must NOT write anything back. */
    function isMergeAborted(r) { return !!(r && r[MERGE_ABORTED] === true); }

    // Decode a Firestore REST typed value (arrayValue/mapValue/...) into plain JS.
    function decodeFs(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
        if ('stringValue' in v) return v.stringValue;
        if ('integerValue' in v) return Number(v.integerValue);
        if ('doubleValue' in v) return Number(v.doubleValue);
        if ('booleanValue' in v) return v.booleanValue;
        if ('nullValue' in v) return null;
        if ('timestampValue' in v) return v.timestampValue;
        if ('mapValue' in v) { const o = {}; const f = (v.mapValue && v.mapValue.fields) || {}; for (const k of Object.keys(f)) o[k] = decodeFs(f[k]); return o; }
        if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decodeFs);
        return v;
    }

    /**
     * Idempotent, data-only normalisation of a user doc (same result on every device, no clock involved):
     * decodes REST {arrayValue} arrays, gives id-less tasks/exams a content id, and clamps every
     * updatedAt/lastModified/uncompletedAt/fieldUpdatedAt stamp to the doc's own lastSync + 5 min (a stamp beyond
     * the doc's own lastSync is skew garbage; docs with a non-epoch lastSync are left alone).
     * normalise(normalise(x)) === normalise(x), and merge output is already normalised, so a clamped and an
     * unclamped copy of the same data hash equal (contentHash normalises first) and exchanges reach a fixed point.
     * @returns {{doc:object}|{error:string}}
     */
    function normalizeDoc(doc) {
        if (!doc || typeof doc !== 'object') return { doc };
        let out = doc;
        const set = (k, v) => { if (out === doc) out = { ...doc }; out[k] = v; };
        for (const k of ARRAY_KEYS) {
            const v = doc[k];
            if (v === undefined || v === null || Array.isArray(v)) continue;
            if (typeof v === 'object' && 'arrayValue' in v) { set(k, decodeFs(v)); continue; }
            return { error: `managed field "${k}" is not an array (${typeof v})` };
        }
        const ls = Number(doc.lastSync);
        const cap = Number.isFinite(ls) && ls >= 1e11 ? ls + STAMP_SKEW_MS : Infinity;
        const clampRec = (r) => {
            if (!r || typeof r !== 'object') return r;
            let o = r;
            if (!r.id) o = withId(r);
            for (const f of ['updatedAt', 'lastModified', 'uncompletedAt']) {
                if (r[f] !== undefined && Number.isFinite(toMs(r[f])) && toMs(r[f]) > cap) { if (o === r) o = { ...r }; o[f] = typeof r[f] === 'number' ? cap : new Date(cap).toISOString(); }
            }
            return o;
        };
        for (const k of ['tasks', 'exams']) {
            const list = out[k];
            if (!Array.isArray(list)) continue;
            const mapped = list.map(clampRec);
            if (mapped.some((x, i) => x !== list[i])) set(k, mapped);
        }
        if (out.fieldUpdatedAt && typeof out.fieldUpdatedAt === 'object') {
            const f = out.fieldUpdatedAt; let nf = null;
            for (const k of Object.keys(f)) if (Number.isFinite(toMs(f[k])) && toMs(f[k]) > cap) { nf = nf || { ...f }; nf[k] = cap; }
            if (nf) set('fieldUpdatedAt', nf);
        }
        return { doc: out };
    }

    /**
     * True for a never-used/default doc: no content, no totals, no non-default scalar (nil, '', 0, false, [], {}),
     * no fieldUpdatedAt. lastSync/username/name/id are ignored on purpose.
     */
    function isEmptyLocal(u) {
        if (!u) return true;
        const len = (a) => (Array.isArray(a) ? a.length : 0);
        if (len(u.tasks) || len(u.pointsHistory) || len(u.streakHistory) || len(u.exams) || len(u.deletedTaskIds) || len(u.deletedExamIds)) return false;
        if (Number(u.taskStreak) > 0 || Number(u.longestStreak) > 0 || Number(u.totalPoints) > 0 || Number(u.weeklyPoints) > 0) return false;
        if (u.updatedAt || (u.fieldUpdatedAt && Object.keys(u.fieldUpdatedAt).length)) return false;
        for (const k of Object.keys(u)) {
            if (MANAGED_KEYS.has(k) || META_KEYS.has(k)) continue;
            if (isDefaultValue(k, u[k])) continue;
            return false;
        }
        return true;
    }

    // A doc's running streak is dead when the merged history already holds a broken record of that very streak.
    /**
     * Live-repo rule (5daaf35/7754fd2/97833e3): an uncompleted task whose due time + 5 min passed kills the running
     * streak immediately, but only a task due AFTER the streak started (5 min tolerance) counts, and a task that already
     * processed a break (streakBreakProcessed / record) must not break a rebuilt streak. includeProcessed: used for a STALE
     * copy in a merge (its streak predates the break). Returns the oldest killer task or null.
     */
    function overdueKiller(doc, tasks, hist, nowMs, includeProcessed) {
        const st = isValidStart(doc && doc.currentStreakStart) ? toMs(doc.currentStreakStart) : 0;
        const brokenIds = new Set((doc && Array.isArray(doc.streakHistory) ? doc.streakHistory : []).map((r) => r && r.brokenByTaskId).filter(Boolean));
        let best = null, bestDue = Infinity;
        for (const t of Array.isArray(tasks) ? tasks : []) {
            if (!t || !t.id || isExemptTask(t) || !t.dueDate || t.givenUp || t.completed || t.completedAt) continue;
            if (taskLooksCompleted(t, hist)) continue;
            if (!includeProcessed && (t.streakBreakProcessed || brokenIds.has(t.id))) continue;
            const due = getDueMs(t);
            if (!Number.isFinite(due) || !(nowMs > due + 5 * 60 * 1000)) continue;
            if (st && due < st - 5 * 60 * 1000) continue;
            if (due < bestDue) { best = t; bestDue = due; }
        }
        return best;
    }

    function liveStreakCount(doc, count, history) {
        if (!(count > 0)) return 0;
        const known = isValidStart(doc.currentStreakStart);
        const st = known ? toMs(doc.currentStreakStart) : -Infinity;
        // Unknown start: a record only kills the streak if the break is not older than the doc's latest counted
        // completion (otherwise the streak was rebuilt after that break). Pure function of the doc's own data.
        let lastDone = -Infinity;
        if (!known) for (const t of Array.isArray(doc.tasks) ? doc.tasks : []) if (advancesStreak(t)) lastDone = Math.max(lastDone, toMs(t.completedAt));
        for (const r of history) {
            if (!r || !((Number(r.length) || 0) >= count)) continue;
            const end = toMs(r.endDate);
            if (!Number.isFinite(end) || end < st) continue;
            if (!known && end < lastDone) continue;
            if (!isValidStart(r.startDate) || toMs(r.startDate) <= st) return 0;
        }
        return count;
    }

    /**
     * Merge two copies of one user doc. Pure, commutative, associative, idempotent (content-wise); never stamps
     * lastSync from the wall clock (lastSync = max of both). opts.now (ms) pins "now" for window/clamps.
     * Returns {aborted:true,error,doNotWrite:true} when a managed array field is corrupt - the caller must then
     * keep local as is and NOT write anything back (see isMergeAborted).
     * UI contract: every scalar edit sets fieldUpdatedAt[key]=Date.now(); every task/exam edit sets updatedAt.
     * Unstamped scalar conflicts: a null/undefined side never overwrites a real value; otherwise the doc with the
     * higher lastSync wins, ties break per field on canonical content.
     */
    function mergeUserData(local, remote, tabWrittenSync, opts) {
        const now = opts && opts.now !== undefined ? toMs(opts.now) : Date.now();
        if (!remote || !local) {
            // lone survivor: still decode REST arrays, give id-less records ids, abort on corrupt fields
            const surv = remote || local;
            if (!surv) return surv;
            const n = normalizeDoc(surv);
            if (n.error) return { aborted: true, doNotWrite: true, error: n.error };
            let d = n.doc;
            for (const k of ['tasks', 'exams']) {
                if (Array.isArray(d[k]) && d[k].some((x) => x && typeof x === 'object' && !x.id)) { if (d === surv) d = { ...d }; d[k] = d[k].map((x) => (x && typeof x === 'object' ? withId(x) : x)); }
            }
            return d;
        }
        const nl = normalizeDoc(local), nr = normalizeDoc(remote);
        if (nl.error || nr.error) return { aborted: true, doNotWrite: true, error: nl.error || nr.error };
        local = nl.doc; remote = nr.doc;

        const remoteSync = Number(remote.lastSync) || 0;
        const localSync = Number(local.lastSync) || 0;
        // An empty/default copy (new phone, cleared storage) always loses, whatever its lastSync says.
        const emptyL = isEmptyLocal(local), emptyR = isEmptyLocal(remote);
        const forced = emptyL && !emptyR ? 1 : (emptyR && !emptyL ? -1 : 0);
        const syncCmp = forced || Math.sign(remoteSync - localSync);
        const ctx = { syncCmp, now };

        const mergedBadges = mergeBadges(local.badges, remote.badges, local, remote);
        const uni = (a, b) => Array.from(new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])).sort();
        const mergedDeletedTaskIds = uni(local.deletedTaskIds, remote.deletedTaskIds);
        const mergedDeletedExamIds = uni(local.deletedExamIds, remote.deletedExamIds);
        const mergedRestored = uni(local.restoredBrokenIds, remote.restoredBrokenIds);
        const mergedDeletedSubjectIds = uni(local.deletedSubjectIds, remote.deletedSubjectIds);
        const mergedSubjects = mergeSubjects(local.subjects, remote.subjects, mergedDeletedSubjectIds);
        const hasSubjects = Array.isArray(local.subjects) || Array.isArray(remote.subjects) || mergedDeletedSubjectIds.length > 0;
        const mergedExams = mergeExams(local.exams || [], remote.exams || [], mergedDeletedExamIds, ctx);

        const mergedPointsHistory = dedupeHealed(mergePointsHistory(local.pointsHistory, remote.pointsHistory));
        const mergedTasks = mergeTasks(local.tasks || [], remote.tasks || [], mergedPointsHistory, mergedDeletedTaskIds, ctx);
        const mergedStreakHistory = mergeStreakHistory(local.streakHistory, remote.streakHistory, mergedRestored);
        const dedupedHistory = dedupePenaltyVariants(mergedPointsHistory, mergedTasks);

        // Streak count: never lose progress to a stale device, but a streak already recorded as broken stays dead.
        let localStreak = Number(local.taskStreak) || 0;
        let remoteStreak = Number(remote.taskStreak) || 0;
        let localLongest = Number(local.longestStreak) || 0;
        let remoteLongest = Number(remote.longestStreak) || 0;


        // a stale copy's streak is dead while a task due inside it is still overdue and open (even one that "processed" a break)
        const liveL = overdueKiller(local, mergedTasks, mergedPointsHistory, now, true) ? 0 : liveStreakCount(local, localStreak, mergedStreakHistory);
        const liveR = overdueKiller(remote, mergedTasks, mergedPointsHistory, now, true) ? 0 : liveStreakCount(remote, remoteStreak, mergedStreakHistory);
        const mergedTaskStreak = Math.max(liveL, liveR);
        const mergedLongestStreak = Math.max(localLongest, remoteLongest, mergedTaskStreak);

        let mergedStreakStart = null;
        let mergedStreakEmojis = [];
        if (mergedTaskStreak > 0) {
            const starts = [];
            if (liveL > 0 && isValidStart(local.currentStreakStart)) starts.push(toMs(local.currentStreakStart));
            if (liveR > 0 && isValidStart(remote.currentStreakStart)) starts.push(toMs(remote.currentStreakStart));
            if (starts.length) {
                const min = Math.min(...starts);
                mergedStreakStart = [local.currentStreakStart, remote.currentStreakStart].find((v) => isValidStart(v) && toMs(v) === min);
            }
            mergedStreakEmojis = Array.from(new Set([
                ...(liveL > 0 && Array.isArray(local.currentStreakEmojis) ? local.currentStreakEmojis : []),
                ...(liveR > 0 && Array.isArray(remote.currentStreakEmojis) ? remote.currentStreakEmojis : [])
            ]));
        }

        // Legacy stored totals: feed ensureOpeningBalance / the no-ledger fallback only (overwritten by the ledger sum below when a ledger exists).
        const mergedTotalPoints = Math.max(Number(local.totalPoints) || 0, Number(remote.totalPoints) || 0);

        const localReset = Number(local.nextWeeklyReset) || 0;
        const remoteReset = Number(remote.nextWeeklyReset) || 0;
        let mergedWeeklyPoints;
        let mergedNextWeeklyReset;
        let mergedNextWeeklyCrowning;

        if (localReset > remoteReset) {
            mergedWeeklyPoints = Number(local.weeklyPoints) || 0;
            mergedNextWeeklyReset = localReset;
            mergedNextWeeklyCrowning = Number(local.nextWeeklyCrowning) || Number(remote.nextWeeklyCrowning) || 0;
        } else if (remoteReset > localReset) {
            mergedWeeklyPoints = Number(remote.weeklyPoints) || 0;
            mergedNextWeeklyReset = remoteReset;
            mergedNextWeeklyCrowning = Number(remote.nextWeeklyCrowning) || Number(local.nextWeeklyCrowning) || 0;
        } else {
            mergedWeeklyPoints = Math.max(Number(local.weeklyPoints) || 0, Number(remote.weeklyPoints) || 0);
            mergedNextWeeklyReset = localReset;
            mergedNextWeeklyCrowning = Math.max(Number(local.nextWeeklyCrowning) || 0, Number(remote.nextWeeklyCrowning) || 0);
        }

        const localWeek = local.lastWeeklyReportSentWeek || '';
        const remoteWeek = remote.lastWeeklyReportSentWeek || '';
        const mergedWeeklyReportSentWeek = localWeek >= remoteWeek ? localWeek : remoteWeek;
        const mergedWeeklyReportSentTime = Math.max(Number(local.lastWeeklyReportSentTime) || 0, Number(remote.lastWeeklyReportSentTime) || 0);
        const mergedGlobalReminderSent = Math.max(Number(local.lastGlobalWhatsAppReminderSent) || 0, Number(remote.lastGlobalWhatsAppReminderSent) || 0);
        const mergedLastCrownedWeekEnd = Math.max(Number(local.lastCrownedWeekEnd) || 0, Number(remote.lastCrownedWeekEnd) || 0);
        const mergedCrownedWeekPoints = Math.max(Number(local.crownedWeekPoints) || 0, Number(remote.crownedWeekPoints) || 0);

        // Scalars: per-field stamp (fieldUpdatedAt) first; unstamped: nil never beats a value, then the empty/default
        // side loses, then higher lastSync, then deterministic per-field content order. No Date.now() anywhere.
        const lf = local.fieldUpdatedAt || {}, rf = remote.fieldUpdatedAt || {};
        const base = {};
        for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
            if (MANAGED_KEYS.has(k)) continue;
            const inL = Object.prototype.hasOwnProperty.call(local, k), inR = Object.prototype.hasOwnProperty.call(remote, k);
            let takeRemote;
            if (!inL) takeRemote = true;
            else if (!inR) takeRemote = false;
            else {
                const lt = msOr0(lf[k]), rt = msOr0(rf[k]);
                if (lt !== rt) takeRemote = rt > lt;
                else if (lt > 0) takeRemote = cmpDet(local[k], remote[k]) < 0; // same stamp (e.g. both capped): content order
                else if (isDefaultValue(k, local[k]) !== isDefaultValue(k, remote[k])) takeRemote = isDefaultValue(k, local[k]); // provenance: unstamped default never beats a real value
                else if (syncCmp !== 0) takeRemote = syncCmp > 0;
                else takeRemote = cmpDet(local[k], remote[k]) < 0;
            }
            base[k] = takeRemote ? remote[k] : local[k];
        }
        const mergedFieldUpdatedAt = {};
        for (const k of new Set([...Object.keys(lf), ...Object.keys(rf)])) mergedFieldUpdatedAt[k] = Math.max(msOr0(lf[k]), msOr0(rf[k]));
        const pickFirst = (k) => (syncCmp > 0 ? (remote[k] || local[k]) : (local[k] || remote[k]));

        let result = {
            ...base,
            tasks: mergedTasks,
            pointsHistory: dedupedHistory,
            streakHistory: mergedStreakHistory,
            taskStreak: mergedTaskStreak,
            longestStreak: mergedLongestStreak,
            currentStreakStart: mergedStreakStart,
            currentStreakEmojis: mergedStreakEmojis,
            totalPoints: mergedTotalPoints,
            weeklyPoints: mergedWeeklyPoints,
            lastCrownedWeekEnd: mergedLastCrownedWeekEnd || pickFirst('lastCrownedWeekEnd'),
            crownedWeekPoints: mergedCrownedWeekPoints || pickFirst('crownedWeekPoints'),
            nextWeeklyCrowning: mergedNextWeeklyCrowning || pickFirst('nextWeeklyCrowning'),
            nextWeeklyReset: mergedNextWeeklyReset || pickFirst('nextWeeklyReset'),
            lastWeeklyReportSentWeek: mergedWeeklyReportSentWeek,
            lastWeeklyReportSentTime: mergedWeeklyReportSentTime,
            lastGlobalWhatsAppReminderSent: mergedGlobalReminderSent,
            badges: mergedBadges,
            exams: mergedExams,
            deletedTaskIds: mergedDeletedTaskIds,
            deletedExamIds: mergedDeletedExamIds,
            lastSync: Math.max(localSync, remoteSync)
        };
        if (hasSubjects) { result.subjects = mergedSubjects; if (mergedDeletedSubjectIds.length) result.deletedSubjectIds = mergedDeletedSubjectIds; }
        if (mergedRestored.length) result.restoredBrokenIds = mergedRestored;
        // penaltyLadderStartedAt: MIN of the non-zero values (never later-wins, never overwritten by a later stamp)
        const pls = [local.penaltyLadderStartedAt, remote.penaltyLadderStartedAt].map(msOr0).filter((n) => n > 0);
        if (pls.length) result.penaltyLadderStartedAt = Math.min(...pls);
        else if ('penaltyLadderStartedAt' in local || 'penaltyLadderStartedAt' in remote) result.penaltyLadderStartedAt = 0;
        if (Object.keys(mergedFieldUpdatedAt).length) result.fieldUpdatedAt = mergedFieldUpdatedAt;

        // Ledger: mint the opening balance against the FULL union first, then drop rows of deleted tasks, then
        // re-derive the stored totals so heal does not mistake the drop for missing points.
        // Opening balance (legacy stored total not backed by ledger rows) is minted in a merge only when exactly one
        // side has a ledger (the other is empty/new) and that side's own total is unexplained. Two ledgers never
        // mint during a merge (keeps merge associative); a single device mints on its own load (heal).
        const hasL = Array.isArray(local.pointsHistory) && local.pointsHistory.length > 0, hasR = Array.isArray(remote.pointsHistory) && remote.pointsHistory.length > 0;
        if (hasL !== hasR) {
            const side = hasL ? local : remote;
            const minted = ensureOpeningBalance(side);
            if (minted !== side && !result.pointsHistory.some((h) => h && h.id === OPENING_ID)) {
                result = { ...result, pointsHistory: [...result.pointsHistory, minted.pointsHistory.find((h) => h.id === OPENING_ID)] };
            }
        }
        // stored totals now follow the ledger (after the opening row), so heal never mints from a stale max
        if (result.pointsHistory.length) result.totalPoints = sumLedger(result.pointsHistory, {});
        if (mergedDeletedTaskIds.length) {
            const del = new Set(mergedDeletedTaskIds);
            const kept = result.pointsHistory.filter((h) => !(h && h.taskId && del.has(h.taskId)));
            if (kept.length !== result.pointsHistory.length) {
                result = { ...result, pointsHistory: kept };
                result.totalPoints = sumLedger(kept, {});
                if (!kept.length) result.weeklyPoints = 0;
            }
        }
        // No ensureStreakStart/repairStreakDates and no ph_healed_ minting here: both derive from partial local data and
        // would make merge order dependent. They run on the single-device load/heal path (healCompletedFromHistory
        // without opts.merge); readers derive a missing start on read (ladder.js safeStreakStart).
        return healCompletedFromHistory(result, now, { merge: true });
    }

    /** Merge that returns `local` untouched when the merge aborted (corrupt remote): never write the result back then. */
    function applyRemoteSafe(local, remote) {
        const m = mergeUserData(local, remote);
        return isMergeAborted(m) ? local : m;
    }

    function applyRemoteUser(local, remote, tabWrittenSync) {
        return mergeUserData(local, remote, tabWrittenSync);
    }

    /**
     * Streak count after restoring a wrongly broken record. If the running streak already contains the
     * record (it started at/before the record ended; or, without usable dates, is at least as long) the result is
     * max(streak, record.length) - never a second addition. Disjoint streaks add up once (record.length + streak).
     * plusOne: running streak 0 means the just-submitted task counts (+1).
     */
    function restoredStreakCount(rec, taskStreak, curStart, plusOne) {
        const len = Number(rec.length) || 0;
        const ts = Number(taskStreak) > 0 ? Number(taskStreak) : 0;
        if (ts === 0) return len + (plusOne ? 1 : 0);
        let overlap;
        if (isValidStart(curStart) && isValidStart(rec.endDate)) overlap = toMs(curStart) <= toMs(rec.endDate);
        else overlap = ts >= len;
        return overlap ? Math.max(ts, len) : len + ts;
    }

    /**
     * Heals completion flags from the ledger, backfills missing ledger rows, restores wrongly broken streaks.
     * Never deletes a ledger row: reversals are explicit refund rows (ph_refund_<penId>). Totals are derived
     * from the ledger when it is non-empty. `now` is optional (tests).
     */
    function healCompletedFromHistory(user, now, opts) {
        if (!user || isMergeAborted(user)) return user;
        const inMerge = !!(opts && opts.merge); // merge path: no minting of healed rows, no streak-start derivation
        const hist0 = user.pointsHistory || [];
        const hist = hist0.filter((h) => !isInvalidPointsHistory(h)); // live-repo purge of bogus rows
        let changed = hist.length !== hist0.length;
        let totalPoints = user.totalPoints || 0;
        let weeklyPoints = user.weeklyPoints || 0;
        let taskStreak = user.taskStreak;
        const restoredIds = new Set(Array.isArray(user.restoredBrokenIds) ? user.restoredBrokenIds : []);
        const restoredBefore = restoredIds.size;
        let streakHistory = (user.streakHistory || []).filter((r) => !(r && r.id && restoredIds.has(r.id)) && !(r && r.id === 'sh_september_baseline'));
        { const seenB = new Set(); streakHistory = streakHistory.filter((r) => { if (!r) return false; if (r.brokenByTaskId) { if (seenB.has(r.brokenByTaskId)) return false; seenB.add(r.brokenByTaskId); } return true; }); }
        if (streakHistory.length !== (user.streakHistory || []).length) changed = true;
        let newHist = [...hist];
        const histIds = ledgerIdSet(newHist); // built once per pass; refund/penalty helpers add to it
        let startRestore = null;
        const mintNow = now !== undefined ? now : Date.now();

        const deletedSet = new Set(Array.isArray(user.deletedTaskIds) ? user.deletedTaskIds : []);
        const subMap = new Map((user.subjects || []).map(s => [s.id, s.name || '']));
        const rawTasks = Array.isArray(user.tasks) ? user.tasks : [];
        const inputTasks = rawTasks.filter(t => {
            if (!t || !t.id) return false;
            if (deletedSet.has(t.id)) {
                changed = true;
                return false;
            }
            const subName = subMap.get(t.subjectId) || '';
            const isPhysics = subName.includes('פיזיקה');
            const isCivics = subName.includes('אזרחות');
            const titleOrTopic = `${t.title || ''} ${t.lessonTopic || ''}`;
            const mentionsCivics = titleOrTopic.includes('אזרחות') || titleOrTopic.includes('אופיה של מדינת ישראל') || titleOrTopic.includes('מגילת העצמאות');
            const mentionsPhysics = titleOrTopic.includes('פיזיקה') || titleOrTopic.includes('קולון') || titleOrTopic.includes('דופלר') || titleOrTopic.includes('אנרגיה חשמלית');

            if (isPhysics && mentionsCivics && !mentionsPhysics) {
                deletedSet.add(t.id);
                changed = true;
                return false;
            }
            if (isCivics && mentionsPhysics && !mentionsCivics) {
                deletedSet.add(t.id);
                changed = true;
                return false;
            }
            return true;
        });

        const tasks = inputTasks.map((t) => {
            if (!t) return t;
            const lockedT = lockBogusCompletion(t);
            if (lockedT !== t) { changed = true; return lockedT; }
            const isDone = taskLooksCompleted(t, hist);
            const onTime = isTaskSubmittedOnTime(t);
            let updated = { ...t };

            if (isDone && !updated.completed) {
                updated.completed = true;
                changed = true;
            }

            // Cross-device duration consistency: keep studyDurationMinutes and studyDurationHours in lockstep (live repo)
            if (!inMerge) {
                const fmtRange = (mins) => { const h = Math.floor(mins / 60), m = mins % 60; return (h > 0 && m > 0) ? `${h} שע' ו-${m} דק'` : (h === 1 ? 'שעה' : (h === 2 ? 'שעתיים' : (h > 0 ? `${h} שעות` : `${m} דקות`))); };
                if (updated.studyDurationMinutes && (!updated.studyDurationHours || !updated.studyTimeRange)) {
                    updated.studyDurationHours = parseFloat((updated.studyDurationMinutes / 60).toFixed(2));
                    updated.studyTimeRange = fmtRange(updated.studyDurationMinutes);
                    changed = true;
                } else if (updated.studyDurationHours && !updated.studyDurationMinutes) {
                    updated.studyDurationMinutes = Math.round(updated.studyDurationHours * 60);
                    updated.studyTimeRange = fmtRange(updated.studyDurationMinutes);
                    changed = true;
                }
            }

            if (onTime || (updated.completed && updated.completedAt)) {
                const subDate = new Date(msOr0(updated.completedAt) || NaN);
                const dueDate = updated.dueDate ? new Date(getDueMs(updated)) : null;
                const wasActuallyOnTime = onTime || isExemptTask(updated) || !updated.dueDate || (dueDate && !isNaN(dueDate.getTime()) && !evaluateLateness(updated, subDate.getTime(), null).late);

                if (wasActuallyOnTime) {
                    if (updated.autoPenaltyApplied) {
                        updated.autoPenaltyApplied = false;
                        changed = true;
                    }
                    if (updated.lateReason) {
                        delete updated.lateReason;
                        changed = true;
                    }

                    // Points calculation
                    let expectedPoints = updated.pointsEarned;
                    if (expectedPoints === undefined || expectedPoints <= 0) {
                        if (updated.isPracticeSession) {
                            expectedPoints = (updated.studyDurationMinutes >= 30 || updated.studyDurationHours >= 0.5) ? 2 : 1;
                        } else if (updated.rewardPoints || updated.isFlexibleExamSession) {
                            expectedPoints = updated.rewardPoints || 3;
                        } else {
                            const createdAt = updated.createdAt ? new Date(msOr0(updated.createdAt) || NaN) : null;
                            expectedPoints = 1;
                            if (dueDate && createdAt && !isNaN(dueDate.getTime()) && !isNaN(createdAt.getTime())) {
                                const totalMs = dueDate.getTime() - createdAt.getTime();
                                const usedMs = subDate.getTime() - createdAt.getTime();
                                if (usedMs <= Math.max(totalMs / 2, 86400000)) expectedPoints = 2;
                            }
                            if (updated.isExamPrep) expectedPoints += 1;
                        }
                    }

                    // Ensure pointsHistory has an entry for this completed task
                    const hasPositiveHist = newHist.some(h => h && h.taskId === updated.id && (h.points || 0) > 0 && !isAutoHistoryId(h.id));
                    if (!hasPositiveHist && !updated.givenUp && !inMerge) {
                        const sub = (user.subjects || []).find(s => s.id === updated.subjectId);
                        const pointsVal = Math.max(1, expectedPoints || (updated.isPracticeSession ? 2 : 1));
                        updated.pointsEarned = pointsVal;
                        const subName = sub ? sub.name : 'כללי';
                        const subEmoji = sub ? sub.emoji : '📚';
                        const detailsStr = updated.isPracticeSession
                            ? `בוצע סשן תרגול מעמיק (+${pointsVal} נקודות)! 💡`
                            : (pointsVal >= 2 ? 'הוגש מוקדם! אלופה.' : 'הוגש בזמן שנקבע.');

                        const healedLog = {
                            id: 'ph_healed_' + updated.id,
                            taskId: updated.id,
                            taskTitle: updated.title,
                            subjectName: subName,
                            subjectEmoji: subEmoji,
                            points: pointsVal,
                            date: updated.completedAt || new Date().toISOString(),
                            details: detailsStr,
                            studyDurationHours: updated.studyDurationHours || null,
                            studyDurationMinutes: updated.studyDurationMinutes || null,
                            studyTimeRange: updated.studyTimeRange || null
                        };

                        // a row the purge would drop again must not be minted (mint/purge oscillation = churn every pass)
                        if (!isInvalidPointsHistory(healedLog)) { newHist.unshift(healedLog); changed = true; }
                    } else if ((updated.pointsEarned === undefined || updated.pointsEarned <= 0) && !updated.givenUp) {
                        const delta = expectedPoints - (updated.pointsEarned || 0);
                        if (delta > 0) {
                            updated.pointsEarned = expectedPoints;
                            changed = true;
                        }
                    }

                    // Penalties on a task that turned out on time: refund rows only, penalty rows stay.
                    const autoPenaltyLogs = newHist.filter(h => h && h.taskId === updated.id && isPenaltyRow(h));
                    const refunds = refundRowsFor(updated.id, newHist, updated.completedAt, 'החזר קנס אוטומטי: ההגשה התקבלה בזמן', undefined, histIds);
                    if (refunds.length > 0) {
                        newHist = [...refunds, ...newHist];
                        changed = true;
                    }

                    // Find if streak was broken by this task
                    let brokenIdx = streakHistory.findIndex(s => s && s.brokenByTaskId === updated.id);
                    if (brokenIdx === -1 && autoPenaltyLogs.length > 0 && dueDate) {
                        brokenIdx = streakHistory.findIndex(s => s && s.endDate && Math.abs(msOr0(s.endDate) - dueDate.getTime()) < 60000);
                    }
                    if (brokenIdx === -1 && autoPenaltyLogs.length > 0 && streakHistory.length > 0 && (taskStreak === 0 || taskStreak === undefined)) {
                        const lastLog = autoPenaltyLogs[autoPenaltyLogs.length - 1];
                        const logTime = lastLog.date ? msOr0(lastLog.date) : 0;
                        const lastStreak = streakHistory[streakHistory.length - 1];
                        const streakTime = lastStreak.id && lastStreak.id.startsWith('sh_') ? parseInt(lastStreak.id.replace('sh_', '')) : 0;
                        if (logTime && streakTime && Math.abs(logTime - streakTime) < 5 * 60 * 1000) {
                            brokenIdx = streakHistory.length - 1;
                        }
                    }

                    if (brokenIdx !== -1) {
                        const brokenRecord = streakHistory[brokenIdx];
                        streakHistory.splice(brokenIdx, 1);
                        if (brokenRecord.id) restoredIds.add(brokenRecord.id);
                        taskStreak = restoredStreakCount(brokenRecord, taskStreak, user.currentStreakStart, true);
                        if (isValidStart(brokenRecord.startDate)) startRestore = brokenRecord.startDate;
                        changed = true;
                    }
                } else if (updated.completed && !updated.givenUp) {
                    // Late completion: the ladder is fixed by completedAt. Void step-2 rows minted by a device that
                    // never saw the completion (deterministic refund row, penalty row stays) ...
                    const evc = evaluateLateness(updated, subDate.getTime(), null);
                    const stepOf = (h) => (String(h.id).startsWith('ph_pen2_') ? 2 : String(h.id).startsWith('ph_pen1_') ? 1 : 0);
                    const voids = refundRowsFor(updated.id, newHist, updated.completedAt, 'ביטול קנס שני: ההגשה בתוך 24 שעות מזמן ההגשה', (h) => stepOf(h) > evc.step, histIds);
                    if (voids.length) { newHist = [...voids, ...newHist]; changed = true; }
                    // ... and backfill a ladder that was flagged (autoPenaltyApplied) but never reached the ledger.
                    if (updated.autoPenaltyApplied) {
                        const rows = penaltyRowsFor(updated, subDate.getTime(), newHist, user.subjects, { now: mintNow, ids: histIds });
                        if (rows.length) {
                            newHist = [...rows, ...newHist];
                            changed = true;
                        }
                    }
                }
            }

            return updated;
        });

        // Preserve weeklyPoints - weekly crowning and points reset are handled safely in weekly reset cycle

        const isShely = (user.username && (user.username === 'שליי' || user.username === 'שלי')) || 
                (user.name && (user.name === 'שלי' || user.name === 'שליי')) || 
                (user.id && (user.id === 'שליי' || user.id === 'שלי' || user.id === '0bH9B6rJ1sduoF2i6k7aD2k4sB33'));
        const isInbar = (user.username && user.username.includes('ענבר')) || (user.name && user.name.includes('ענבר'));

        // Streak healing: preserve real active streak without artificial lifetime task inflation
        let streakVal = taskStreak !== undefined ? taskStreak : (user.taskStreak || 0);
        let longestVal = user.longestStreak || 0;
        // Immediate overdue break on load/heal (live repo); merge path leaves it to mergeUserData's overdueKiller.
        let killRec = null;
        if (!inMerge && Number(streakVal) > 0) {
            const killer = overdueKiller(user, tasks, newHist, mintNow, false);
            if (killer) {
                const due = getDueMs(killer);
                const len = Number(streakVal) || 0;
                longestVal = Math.max(Number(longestVal) || 0, len);
                if (!streakHistory.some((r) => r && r.brokenByTaskId === killer.id)) {
                    killRec = {
                        id: 'sh_' + killer.id + '_broken',
                        startDate: isValidStart(user.currentStreakStart) ? user.currentStreakStart : (deriveStreakStart(tasks, len, due + 1) || new Date(due).toISOString()),
                        endDate: new Date(due).toISOString(),
                        length: len,
                        emojis: [...(user.currentStreakEmojis || [])],
                        brokenByTaskId: killer.id,
                    };
                    streakHistory = [...streakHistory, killRec];
                }
                streakVal = 0;
                changed = true;
            }
        }
        const safeStreak = Math.max(streakVal, 0);
        const safeLongest = Math.max(longestVal, safeStreak);

        // Canonical Crown Architecture: Distinct wonWeeks Set
        // Shely has 5 official wins up to Week 44. Inbar has 4 official wins.
        // Count is derived deterministically from wonWeeks so it can NEVER inflate arbitrarily.
        let badges = user.badges ? [...user.badges] : [];
        if (badges.length > 0) {
            const champBadgeIdx = badges.findIndex(b => (typeof b === 'object' && b && b.id === 'b_weekly_champ'));
            if (champBadgeIdx !== -1) {
                const bObj = { ...badges[champBadgeIdx] };
                let wonWeeks = Array.isArray(bObj.wonWeeks) ? Array.from(new Set(bObj.wonWeeks)) : [];
                
                const lastWonTime = bObj.lastWonAt ? new Date(bObj.lastWonAt).getTime() : 0;
                const hasFutureTimestamp = lastWonTime >= 1794081600000; // on or after Nov 7, 2026 22:00

                if (isShely) {
                    const baseWeeksShely = ['2026-W37', '2026-W38', '2026-W40', '2026-W42', '2026-W44'];
                    let futureWeeks = wonWeeks.filter(w => w > '2026-W44' && w !== '2026-W45'); // W45 was Inbar's (live repo)
                    const finalWeeks = Array.from(new Set([...baseWeeksShely, ...futureWeeks]));
                    bObj.wonWeeks = finalWeeks;
                    bObj.count = finalWeeks.length;
                    bObj.lastWonWeek = finalWeeks[finalWeeks.length - 1] || '2026-W44';
                    badges[champBadgeIdx] = bObj;
                    changed = true;
                } else if (isInbar) {
                    const baseWeeksInbar = ['2026-W36', '2026-W39', '2026-W41', '2026-W43', '2026-W45'];
                    let futureWeeks = wonWeeks.filter(w => w > '2026-W45');
                    const finalWeeks = Array.from(new Set([...baseWeeksInbar, ...futureWeeks]));
                    bObj.wonWeeks = finalWeeks;
                    bObj.count = finalWeeks.length;
                    bObj.lastWonWeek = finalWeeks[finalWeeks.length - 1] || '2026-W45';
                    badges[champBadgeIdx] = bObj;
                    changed = true;
                }
            }
        }

        newHist = dedupeHealed(newHist);
        if (newHist.length !== hist.length) changed = true;
        if (newHist.length > 0) {
            const withOpen = ensureOpeningBalance({ pointsHistory: newHist, totalPoints: user.totalPoints });
            if (withOpen.pointsHistory !== newHist) { newHist = withOpen.pointsHistory; changed = true; }
        }
        // Headline numbers are derived from the ledger (when there is one)
        if (newHist.length > 0) {
            const d = deriveTotals({ pointsHistory: newHist }, now);
            if (d.totalPoints !== user.totalPoints || d.weeklyPoints !== user.weeklyPoints) changed = true;
            totalPoints = d.totalPoints;
            weeklyPoints = d.weeklyPoints;
        }

        const startWasBad = !inMerge && safeStreak > 0 && !isValidStart(startRestore || user.currentStreakStart);
        if (!changed && !startWasBad && safeStreak === (user.taskStreak || 0) && safeLongest === (user.longestStreak || 0)) {
            return user;
        }

        const healed = {
            ...user,
            tasks,
            totalPoints,
            weeklyPoints,
            pointsHistory: newHist,
            badges: badges.length > 0 ? badges : user.badges,
            taskStreak: safeStreak,
            longestStreak: safeLongest,
            streakHistory,
            deletedTaskIds: Array.from(deletedSet).sort()
        };
        if (startRestore && !isValidStart(user.currentStreakStart)) healed.currentStreakStart = startRestore;
        if (killRec || (!inMerge && Number(user.taskStreak) > 0 && safeStreak === 0)) { healed.currentStreakStart = null; healed.currentStreakEmojis = []; }
        if (restoredIds.size !== restoredBefore || Array.isArray(user.restoredBrokenIds)) healed.restoredBrokenIds = Array.from(restoredIds).sort();
        return inMerge ? healed : ensureStreakStart(healed);
    }

    /**
     * An on-time edit of the due date reverses penalties with explicit refund rows (ph_refund_<penId>);
     * penalty rows are never deleted. Idempotent. Restores a streak broken by this task with a valid start.
     */
    function restoreOnDueEdit(prev, taskId, oldDue, newDue, now) {
        if (!prev || !taskId || !newDue) return prev;
        const nowDate = now instanceof Date ? now : new Date(now || Date.now());
        const newMs = newDue instanceof Date ? newDue.getTime() : new Date(newDue).getTime();
        if (!(newMs > nowDate.getTime())) return prev;

        const tasks = (prev.tasks || []).map((t) =>
            t.id === taskId ? { ...t, autoPenaltyApplied: false } : t
        );
        const refunds = refundRowsFor(taskId, prev.pointsHistory || [], nowDate.toISOString(), 'החזר קנס אוטומטי אחרי עדכון תאריך הגשה');
        const pointsHistory = [...refunds, ...(prev.pointsHistory || [])];

        let streakHistory = [...(prev.streakHistory || [])];
        let taskStreak = prev.taskStreak;
        let currentStreakStart = prev.currentStreakStart;
        let currentStreakEmojis = prev.currentStreakEmojis;
        const restored = new Set(Array.isArray(prev.restoredBrokenIds) ? prev.restoredBrokenIds : []);
        const idx = streakHistory.findIndex((s) => s.brokenByTaskId === taskId && !(s.id && restored.has(s.id)));
        if (idx !== -1) {
            const rec = streakHistory[idx];
            streakHistory.splice(idx, 1);
            if (rec.id) restored.add(rec.id);
            const cur = taskStreak || 0;
            taskStreak = restoredStreakCount(rec, cur, currentStreakStart, false);
            if (cur === 0 || !isValidStart(currentStreakStart) || (isValidStart(rec.startDate) && toMs(rec.startDate) < toMs(currentStreakStart))) {
                currentStreakStart = isValidStart(rec.startDate) ? rec.startDate : (cur === 0 ? null : currentStreakStart);
            }
            if (cur === 0) currentStreakEmojis = rec.emojis || [];
        }

        let out = {
            ...prev,
            tasks,
            pointsHistory,
            streakHistory,
            ...(restored.size ? { restoredBrokenIds: Array.from(restored).sort() } : {}),
            taskStreak: taskStreak ?? (prev.taskStreak || 0),
            currentStreakStart: currentStreakStart !== undefined ? currentStreakStart : (prev.currentStreakStart || null),
            currentStreakEmojis: currentStreakEmojis !== undefined ? currentStreakEmojis : (prev.currentStreakEmojis || []),
        };
        if (pointsHistory.length > 0) Object.assign(out, deriveTotals(out, nowDate));
        return ensureStreakStart(out, nowDate.toISOString());
    }

    /**
     * Honest sync indicator. synced only when: online, pull ok, outbox empty, last push acked, hashes equal.
     * Precedence: offline > error > pending > synced.
     * @returns {{state:'synced'|'pending'|'error'|'offline', reason:string}}
     */
    function computeSyncStatus(i) {
        const s = i || {};
        if (s.online === false) return { state: 'offline', reason: 'offline' };
        if (s.lastError) return { state: 'error', reason: 'error: ' + (s.lastError.message || s.lastError) };
        if (!s.pullOk) return { state: 'pending', reason: 'pull_not_done' };
        if ((Number(s.outboxCount) || 0) > 0) return { state: 'pending', reason: 'outbox_pending' };
        if (!s.lastPushAckAt) return { state: 'pending', reason: 'push_not_acked' };
        if (isNil(s.localHash) || isNil(s.cloudHash)) return { state: 'pending', reason: 'hash_unknown' };
        if (s.localHash !== s.cloudHash) return { state: 'pending', reason: 'hash_mismatch' };
        return { state: 'synced', reason: 'ok' };
    }

    const api = {
        getWindowStart,
        nextWindowStart,
        getNextSaturday22PM,
        jerusalemMs,
        toMs,
        DUE_TZ,
        applyRemoteSafe,
        sumLedger,
        deriveTotals,
        isExemptTask,
        evaluateLateness,
        getDueMs,
        penaltyRowsFor,
        refundRowsFor,
        isPenaltyRow,
        isValidStart,
        deriveStreakStart,
        ensureStreakStart,
        repairStreakDates,
        contentHash,
        isEmptyLocal,
        computeSyncStatus,
        isMergeAborted,
        normalizeDoc,
        isDefaultValue,
        DEFAULT_USER_FIELDS,
        alreadyBrokenIds,
        hasStreakBreakFor,
        refundCompletionRowsOnly,
        refundPenaltiesIfNotOverdue,
        MERGE_ABORTED,
        HASH_IGNORE_KEYS,
        advancesStreak,
        restoredStreakCount,
        ensureOpeningBalance,
        mergeTasks,
        mergeExams,
        applyRemoteUser,
        mergeUserData,
        mergePointsHistory,
        mergeStreakHistory,
        verifyAndRepairStreakAndTasks,
        healCompletedFromHistory,
        restoreOnDueEdit,
        taskLooksCompleted,
        isTaskSubmittedOnTime,
        isAutoHistoryId,
        getLastSaturday22PM,
        getCurrentWeekStart,
        getNextWeekReset,
        getLastWeekReset,
        getEffectiveWeeklyPoints,
        mergeSubjects,
        isInvalidPointsHistory,
        lockBogusCompletion,
        isLockedTaskId: (id) => LOCKED_TASK_IDS.has(id),
        isTestTask,
        normalizeBadge,
        mergeBadges,
        markPendingSync,
        getPendingSync,
        clearPendingSync,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    for (const k of ['getWindowStart', 'sumLedger', 'deriveTotals', 'isExemptTask', 'evaluateLateness', 'getDueMs', 'penaltyRowsFor',
        'refundRowsFor', 'isPenaltyRow', 'isValidStart', 'deriveStreakStart', 'ensureStreakStart', 'repairStreakDates',
        'contentHash', 'isEmptyLocal', 'computeSyncStatus', 'isMergeAborted', 'isDefaultValue', 'hasStreakBreakFor', 'alreadyBrokenIds', 'refundCompletionRowsOnly', 'refundPenaltiesIfNotOverdue', 'applyRemoteSafe', 'jerusalemMs', 'toMs', 'nextWindowStart', 'advancesStreak', 'restoredStreakCount', 'ensureOpeningBalance']) root[k] = api[k];
    root.mergeTasks = mergeTasks;
    root.mergeExams = mergeExams;
    root.applyRemoteUser = applyRemoteUser;
    root.mergeUserData = mergeUserData;
    root.mergePointsHistory = mergePointsHistory;
    root.mergeStreakHistory = mergeStreakHistory;
    root.verifyAndRepairStreakAndTasks = verifyAndRepairStreakAndTasks;
    root.healCompletedFromHistory = healCompletedFromHistory;
    root.restoreOnDueEdit = restoreOnDueEdit;
    root.taskLooksCompleted = taskLooksCompleted;
    root.isTaskSubmittedOnTime = isTaskSubmittedOnTime;
    root.getLastSaturday22PM = getLastSaturday22PM;
    root.getCurrentWeekStart = getCurrentWeekStart;
    root.getNextWeekReset = getNextWeekReset;
    root.getLastWeekReset = getLastWeekReset;
    root.getEffectiveWeeklyPoints = getEffectiveWeeklyPoints;
    root.mergeSubjects = mergeSubjects;
    root.isLockedTaskId = api.isLockedTaskId; root.isInvalidPointsHistory = isInvalidPointsHistory; root.lockBogusCompletion = lockBogusCompletion;
    root.normalizeBadge = normalizeBadge;
    root.mergeBadges = mergeBadges;
    root.markPendingSync = markPendingSync;
    root.getPendingSync = getPendingSync;
    root.clearPendingSync = clearPendingSync;
})(typeof globalThis !== "undefined" ? globalThis : this);
