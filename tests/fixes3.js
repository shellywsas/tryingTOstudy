// Fix pass 3: H1 livelock fixed point, H2 settings provenance, M6 tie-breaks, M7, L9.
const assert = require('assert');
const sync = require('../js/sync-helpers.js');
const helpers = require('../js/helpers.js');
const { test, mulberry32 } = require('./harness.js');
const J = sync.jerusalemMs;
const iso = (ms) => new Date(ms).toISOString();
const NOW = J(2026, 11, 13, 12);
const hw = (o = {}) => ({ id: 't1', title: 'ש', subjectId: 's1', dueDate: '2026-11-12', dueTime: '22:00', ...o });
const base = (o = {}) => ({ username: 'u', name: 'u', tasks: [], pointsHistory: [], streakHistory: [], exams: [], badges: [],
    deletedTaskIds: [], deletedExamIds: [], taskStreak: 0, longestStreak: 0, lastSync: 0, ...o });
const mg = (a, b, now = NOW) => sync.mergeUserData(a, b, undefined, { now });
const H = (u) => sync.contentHash(u);
const DUE = J(2026, 11, 12, 22);
const YEAR = 365 * 864e5;

// ---------- H1 ----------
function exchange(cloud, A, B, nowA, nowB) { // one engine round per replica: transactional read-merge-write
    let changes = 0;
    for (const [rep, now] of [[A, nowA], [B, nowB]]) {
        const merged = mg(cloud, rep.doc, now);
        if (H(merged) !== H(cloud)) { cloud = merged; changes++; }
        const back = mg(rep.doc, cloud, now);
        if (H(back) !== H(rep.doc)) changes++;
        rep.doc = back;
    }
    return { cloud, changes };
}
test('H1 clock skew +-1 year: replicas reach a fixed point in <= 3 rounds, no livelock (pp.js)', () => {
    for (let seed = 1; seed <= 400; seed++) {
        const rnd = mulberry32(seed);
        const T = NOW;
        const skew = [0, [600e3, YEAR, -YEAR, 5 * 60e3, 301e3][Math.floor(rnd() * 5)]];
        let tick = 0, nid = 0;
        const mkd = () => base({ lastSync: T - 1e5, tasks: [{ id: 'a', title: 'a', dueDate: '2099-01-01', completed: false, updatedAt: T - 9e5 }] });
        const R = [{ doc: mkd() }, { doc: mkd() }];
        for (let s = 0; s < 8; s++) {
            const i = Math.floor(rnd() * 2), st = T + (++tick) * 1000 + skew[i], d = R[i].doc;
            const op = Math.floor(rnd() * 4);
            if (op === 0) R[i].doc = { ...d, lastSync: st, tasks: [...d.tasks, { id: 'n' + nid++, title: 'x', dueDate: '2099-01-01', completed: false, updatedAt: st }] };
            else if (op === 1 && d.tasks.length) { const t = d.tasks[0]; R[i].doc = { ...d, lastSync: st, tasks: d.tasks.slice(1), deletedTaskIds: [...d.deletedTaskIds, t.id] }; }
            else if (op === 2 && d.tasks.length) R[i].doc = { ...d, lastSync: st, tasks: d.tasks.map((t, j) => j ? t : { ...t, title: 'e' + st, updatedAt: st }) };
            else R[i].doc = { ...d, lastSync: st, theme: 'v' + st, fieldUpdatedAt: { ...(d.fieldUpdatedAt || {}), theme: st } };
        }
        let cloud = mkd(), rounds = 0, ch;
        do { ({ cloud, changes: ch } = exchange(cloud, R[0], R[1], T + 1e6 + skew[0], T + 1e6 + skew[1])); rounds++; } while (ch && rounds < 6);
        assert.ok(rounds <= 3, `seed ${seed}: ${rounds} rounds`);
        assert.strictEqual(H(R[0].doc), H(cloud)); assert.strictEqual(H(R[1].doc), H(cloud));
    }
});

test('H1 normalizeDoc idempotent; merge(x,x), merge(normalise(m),m) fixed; hash equal for clamped/unclamped copies', () => {
    const x = base({ lastSync: NOW, theme: 'a', fieldUpdatedAt: { theme: NOW + YEAR }, tasks: [{ id: 't', title: 'far', updatedAt: NOW + 3 * YEAR }, { title: 'noid' }] });
    const n = sync.normalizeDoc(x).doc;
    assert.deepStrictEqual(sync.normalizeDoc(n).doc, n);
    assert.ok(n.tasks[0].updatedAt <= NOW + 300000 && n.tasks.every(t => t.id));
    assert.strictEqual(H(x), H(n));
    const m = mg(x, x);
    assert.strictEqual(H(mg(m, m)), H(m));
    assert.strictEqual(H(mg(n, m)), H(sync.normalizeDoc(m).doc));
    assert.strictEqual(JSON.stringify(sync.normalizeDoc(m).doc), JSON.stringify(m));
});

// ---------- H2 ----------
const rich = () => base({ lastSync: NOW - 5e6, subjects: [{ id: 's1', name: 'מתמטיקה', emoji: '📐' }], parentPhoneNumber: '0501234567',
    whatsappGateway: { instanceId: '77', apiToken: 'tok', host: 'https://api.green-api.com' }, autoSendParentReport: false,
    scheduleSettings: [{ day: 0, schoolEndTime: '14:00', anchors: [] }], sendReportToPrimaryParentOnly: true,
    tasks: [{ id: 'c1', title: 'cloud', updatedAt: 5, dueDate: '2099-01-01' }] });
const phoneDefault = () => ({ ...base({ lastSync: NOW + 9e6 }), name: 'תלמיד/ה', subjects: [], scheduleSettings: [0, 1, 2, 3, 4, 5, 6].map(d => ({ day: d, schoolEndTime: '', anchors: [] })),
    parentPhoneNumber: '', parentPhoneNumber2: '', whatsappGateway: { instanceId: '', apiToken: '', host: 'https://api.green-api.com' }, autoSendParentReport: true,
    sendReportToPrimaryParentOnly: false, friends: [], notifications: [], lastTaskRemindersSent: {}, tasks: [{ id: 'p1', title: 'phone task', updatedAt: NOW, dueDate: '2099-01-01' }] });
test('H2 default phone + 1 task never wipes cloud settings (both merge orders); task kept', () => {
    for (const m of [mg(phoneDefault(), rich()), mg(rich(), phoneDefault())]) {
        assert.strictEqual(m.subjects.length, 1);
        assert.strictEqual(m.parentPhoneNumber, '0501234567');
        assert.strictEqual(m.whatsappGateway.apiToken, 'tok');
        assert.strictEqual(m.autoSendParentReport, false);
        assert.strictEqual(m.sendReportToPrimaryParentOnly, true);
        assert.strictEqual(m.scheduleSettings[0].schoolEndTime, '14:00');
        assert.deepStrictEqual(m.tasks.map(t => t.id).sort(), ['c1', 'p1']);
    }
    assert.strictEqual(H(mg(phoneDefault(), rich())), H(mg(rich(), phoneDefault())));
    // continue-locally flow: phone default that the user then edited one setting on (stamped) keeps that edit only
    const edited = { ...phoneDefault(), parentPhoneNumber2: '0509999999', fieldUpdatedAt: { parentPhoneNumber2: NOW } };
    for (const m of [mg(edited, rich()), mg(rich(), edited)]) {
        assert.strictEqual(m.parentPhoneNumber2, '0509999999');
        assert.strictEqual(m.parentPhoneNumber, '0501234567');
        assert.strictEqual(m.whatsappGateway.apiToken, 'tok');
    }
    // unstamped non-default local vs unstamped non-default remote: lastSync decides, commutative
    const l = base({ lastSync: 5, goal: 'x' }), r = base({ lastSync: 9, goal: 'y' });
    assert.strictEqual(mg(l, r).goal, 'y'); assert.strictEqual(mg(r, l).goal, 'y');
});
test('H2 isDefaultValue matches helpers.js DEFAULT_USER_STATE and treats real values as non-default', () => {
    for (const k of Object.keys(helpers.DEFAULT_USER_STATE)) {
        if (k === 'nextWeeklyReset') continue;
        assert.strictEqual(sync.isDefaultValue(k, helpers.DEFAULT_USER_STATE[k]), true, k);
    }
    assert.strictEqual(sync.isDefaultValue('autoSendParentReport', false), false);
    assert.strictEqual(sync.isDefaultValue('parentPhoneNumber', '050'), false);
    assert.strictEqual(sync.isDefaultValue('subjects', [{ id: 's' }]), false);
    assert.strictEqual(sync.isDefaultValue('whatsappGateway', { instanceId: '1', apiToken: '', host: 'https://api.green-api.com' }), false);
    assert.strictEqual(sync.isDefaultValue('somethingNew', undefined), true);
});

// ---------- M6 ----------
function sim(seed) {
    const rnd = mulberry32(seed); let tick = 1000, nid = 0;
    const reps = Array.from({ length: 3 }, () => base({ theme: 't0', subjects: [{ id: 's1', name: 'm', emoji: 'x' }] }));
    const nowOf = () => J(2026, 11, 10, 8) + (++tick) * 600000;
    // strictly increasing per replica, but replicas often share a stamp -> equal stamps, different content
    const stampOf = (r) => { if (rnd() < 0.5) tick++; const v = Math.max(tick, (r.lastSync || 0) + 1); tick = Math.max(tick, v); return v; };
    const ops = [
        (r) => { const id = 't' + (nid++); const s = stampOf(r); const d = new Date(nowOf() + (rnd() * 90 - 40) * 3600000).toISOString(); return { ...r, lastSync: s, tasks: [{ id, title: 'n' + s + rnd(), subjectId: 's1', dueDate: d.slice(0, 10), dueTime: d.slice(11, 16), updatedAt: s }, ...r.tasks] }; },
        (r) => { if (!r.tasks.length) return r; const k = Math.floor(rnd() * r.tasks.length); const s = stampOf(r); return { ...r, lastSync: s, tasks: r.tasks.map((t, j) => j === k && !t.completed ? { ...t, title: 'e' + s + rnd(), updatedAt: s } : t) }; },
        (r) => { const open = r.tasks.filter(t => !t.completed); if (!open.length) return r; const t = open[Math.floor(rnd() * open.length)]; const s = stampOf(r); const at = nowOf();
            const done = { ...t, completed: true, completedAt: iso(at), pointsEarned: 1 + Math.floor(rnd() * 2), updatedAt: s };
            const ev = sync.evaluateLateness(done, at, at); if (ev.late) done.autoPenaltyApplied = true;
            const rows = ev.late ? sync.penaltyRowsFor(done, at, r.pointsHistory, r.subjects, { now: at }) : [{ id: 'ph_' + t.id, taskId: t.id, points: 1, date: iso(at) }];
            return { ...r, lastSync: s, tasks: r.tasks.map(x => x.id === t.id ? done : x), pointsHistory: [...rows, ...r.pointsHistory] }; },
        (r) => { let ph = r.pointsHistory, tasks = r.tasks; const at = nowOf(); const s = ++tick;
            for (const t of r.tasks) { if (t.completed) continue; const rows = sync.penaltyRowsFor(t, at, ph, r.subjects, { now: at }); if (rows.length) { ph = [...rows, ...ph]; tasks = tasks.map(x => x.id === t.id ? { ...x, autoPenaltyApplied: true } : x); } }
            return { ...r, lastSync: s, tasks, pointsHistory: ph }; },
        (r) => { const open = r.tasks.filter(t => !t.completed); if (!open.length) return r; const t = open[Math.floor(rnd() * open.length)]; const s = stampOf(r);
            const nd = new Date(nowOf() + 3 * 86400000).toISOString(); const edited = { ...t, dueDate: nd.slice(0, 10), dueTime: nd.slice(11, 16), updatedAt: s, autoPenaltyApplied: false };
            return { ...sync.restoreOnDueEdit({ ...r, tasks: r.tasks.map(x => x.id === t.id ? edited : x) }, t.id, t.dueDate, sync.getDueMs(edited), nowOf()), lastSync: s }; },
        (r) => { if (!r.tasks.length) return r; const t = r.tasks[Math.floor(rnd() * r.tasks.length)]; const s = ++tick; return { ...r, lastSync: s, tasks: r.tasks.filter(x => x.id !== t.id), deletedTaskIds: [...r.deletedTaskIds, t.id] }; },
        (r) => { const s = stampOf(r); return { ...r, lastSync: s, theme: 't' + s + rnd(), fieldUpdatedAt: { ...(r.fieldUpdatedAt || {}), theme: s } }; },
        (r) => { const t = r.tasks.find(x => x.completed); if (!t) return r; const s = stampOf(r); const u = nowOf(); return { ...r, lastSync: s, tasks: r.tasks.map(x => x.id === t.id ? (({ completedAt, ...rest }) => ({ ...rest, completed: false, uncompletedAt: u, updatedAt: s }))(x) : x) }; },
    ];
    return { reps, rnd, ops };
}
test('M6 3000 seeds with equal-stamp ties: associativity, commutativity, idempotence, absorption, old-snapshot re-merge', () => {
    for (let seed = 1; seed <= 3000; seed++) {
        const { reps, rnd, ops } = sim(seed);
        const snaps = [];
        for (let s = 0; s < 14; s++) { const i = Math.floor(rnd() * 3); reps[i] = ops[Math.floor(rnd() * ops.length)](reps[i]); snaps.push(reps[i]); }
        const [a, b, c] = reps; const mn = J(2026, 11, 20); const m = (x, y) => mg(x, y, mn);
        const l = m(m(a, b), c);
        assert.strictEqual(H(l), H(m(a, m(b, c))), 'assoc ' + seed);
        assert.strictEqual(H(l), H(m(m(a, c), b)), 'order ' + seed);
        assert.strictEqual(H(m(a, b)), H(m(b, a)), 'comm ' + seed);
        assert.strictEqual(H(m(l, l)), H(l), 'idem ' + seed);
        assert.strictEqual(H(m(l, a)), H(l), 'absorb ' + seed);
        // autoPenaltyApplied is an informational OR-flag (M7): an old snapshot may set it again, so ignore it here
        const HF = (u) => H({ ...u, tasks: u.tasks.map(t => ({ ...t, autoPenaltyApplied: false })) });
        for (const sn of snaps.slice(-3)) assert.strictEqual(HF(m(l, sn)), HF(l), 'remerge old ' + seed);
    }
});

// ---------- M7 ----------
test('M7 penaltyLadderStartedAt = MIN of non-zero values, order independent; autoPenaltyApplied OR', () => {
    const a = base({ lastSync: 1, penaltyLadderStartedAt: 900, fieldUpdatedAt: { penaltyLadderStartedAt: 900 } });
    const b = base({ lastSync: 9, penaltyLadderStartedAt: 500, fieldUpdatedAt: { penaltyLadderStartedAt: 500 } });
    const c = base({ lastSync: 20, penaltyLadderStartedAt: 0 });
    const d = base({ lastSync: 30, penaltyLadderStartedAt: 2000, fieldUpdatedAt: { penaltyLadderStartedAt: 99999 } });
    for (const m of [mg(a, b), mg(b, a), mg(mg(a, c), b), mg(c, mg(d, mg(a, b)))]) assert.strictEqual(m.penaltyLadderStartedAt, 500);
    assert.strictEqual(mg(c, c).penaltyLadderStartedAt === undefined || mg(c, c).penaltyLadderStartedAt === 0, true);
    const pen = [{ id: `ph_pen1_t1_${DUE}`, taskId: 't1', points: -1, date: iso(DUE), dueMs: DUE }];
    const old = base({ lastSync: 1, pointsHistory: pen, tasks: [hw({ autoPenaltyApplied: true, updatedAt: 5 })] });
    const cleared = base({ lastSync: 3, pointsHistory: pen, tasks: [hw({ autoPenaltyApplied: false, updatedAt: 9 })] });
    for (const m of [mg(old, cleared), mg(cleared, old)]) assert.strictEqual(m.tasks[0].autoPenaltyApplied, true); // overdue + active penalty: OR
});

// ---------- L9 ----------
test('L9 hasStreakBreakFor / alreadyBrokenByTaskIds / refund helpers', () => {
    const u = { streakHistory: [{ id: 'sh', brokenByTaskId: 't1', length: 3 }] };
    assert.strictEqual(sync.hasStreakBreakFor(u, 't1'), true);
    assert.strictEqual(sync.hasStreakBreakFor(u, 't2'), false);
    assert.strictEqual(sync.hasStreakBreakFor(null, 't2'), false);
    const rows = sync.penaltyRowsFor(hw(), DUE + 600000, [], [], { now: DUE + 600000, alreadyBrokenByTaskIds: new Set(['t1']) });
    assert.strictEqual(rows[0].streakAlreadyBroken, true);
    assert.ok(!('streakAlreadyBroken' in sync.penaltyRowsFor(hw(), DUE + 600000, [], [], { now: DUE + 600000 })[0]));
    assert.deepStrictEqual([...sync.alreadyBrokenIds(u)], ['t1']);

    const led = [
        { id: 'ph_x', taskId: 't1', points: 2, date: iso(DUE - 1e6) },
        { id: 'ph_healed_t1', taskId: 't1', points: 1, date: iso(DUE - 1e6) },
        { id: `ph_pen1_t1_${DUE}`, taskId: 't1', points: -1, date: iso(DUE) },
        { id: 'ph_refund_other', taskId: 't1', points: 1, date: iso(DUE) },
        { id: 'ph_other', taskId: 't9', points: 5, date: iso(DUE) },
    ];
    const r = sync.refundCompletionRowsOnly(led, 't1', iso(DUE + 5));
    assert.deepStrictEqual(r.map(x => x.id).sort(), ['ph_refund_ph_healed_t1', 'ph_refund_ph_x']);
    assert.ok(r.every(x => x.points < 0 && x.taskId === 't1'));
    assert.deepStrictEqual(sync.refundCompletionRowsOnly([...led, ...r], 't1', iso(DUE + 9)), []);

    const pen = [{ id: `ph_pen1_t1_${DUE}`, taskId: 't1', points: -1, date: iso(DUE), dueMs: DUE }, { id: `ph_pen2_t1_${DUE}`, taskId: 't1', points: -1, date: iso(DUE + 864e5), dueMs: DUE }];
    assert.deepStrictEqual(sync.refundPenaltiesIfNotOverdue(hw(), pen, DUE + 600000).map(x => x.id), [`ph_refund_ph_pen2_t1_${DUE}`]); // step 2 not due yet
    const future = hw({ dueDate: '2026-11-20' });
    assert.deepStrictEqual(sync.refundPenaltiesIfNotOverdue(future, pen, DUE).map(x => x.id).sort(), [`ph_refund_ph_pen1_t1_${DUE}`, `ph_refund_ph_pen2_t1_${DUE}`]);
    assert.deepStrictEqual(sync.refundPenaltiesIfNotOverdue(hw(), pen, DUE + 30 * 3600000), []);
    assert.deepStrictEqual(sync.refundPenaltiesIfNotOverdue(hw(), pen, DUE + 2 * 3600000).map(x => x.id), [`ph_refund_ph_pen2_t1_${DUE}`]);
});
