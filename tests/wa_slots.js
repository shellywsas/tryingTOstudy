const assert = require('assert');
const W = require('../js/wa-slots.js');
// Jerusalem is UTC+2 in Nov (no DST): 2026-11-14 is a Saturday
const at = (iso) => Date.parse(iso);
const ids = (iso, cfg) => W.dueSlots(at(iso), cfg).map(s => s.id);

// reminders: only 17:00 and 20:00 (+grace), nothing between
assert.deepStrictEqual(ids('2026-11-11T15:00:00Z'), ['rem-2026-11-11-1700']);   // 17:00 local
assert.deepStrictEqual(ids('2026-11-11T18:00:00Z'), ['rem-2026-11-11-2000']);   // 20:00 local
assert.deepStrictEqual(ids('2026-11-11T13:00:00Z'), []);                        // 15:00 local
assert.deepStrictEqual(ids('2026-11-11T16:45:00Z'), []);                        // 18:45 local, past 17:00 grace
assert.deepStrictEqual(ids('2026-11-11T19:31:00Z'), []);                        // 21:31 local, past 20:00 grace
// weekly: Saturday 19:00 local = 17:00Z; Sunday catch-up until 12:00; none Friday or Sunday afternoon
assert.deepStrictEqual(ids('2026-11-14T16:59:00Z'), []);
const sat = W.dueSlots(at('2026-11-14T17:00:00Z')).find(s => s.kind === 'weekly');
assert.strictEqual(sat.id, 'weekly-2026-11-14'); assert.strictEqual(sat.weekStart, '2026-11-08');
assert.strictEqual(W.dueSlots(at('2026-11-15T08:00:00Z')).find(s => s.kind === 'weekly').id, 'weekly-2026-11-14'); // Sun 10:00
assert.ok(!W.dueSlots(at('2026-11-15T11:00:00Z')).some(s => s.kind === 'weekly'));                                  // Sun 13:00
assert.ok(!W.dueSlots(at('2026-11-13T17:00:00Z')).some(s => s.kind === 'weekly'));                                  // Friday
// week ids sort and never collide across W9/W10 (date-keyed)
assert.ok('weekly-2026-03-07' < 'weekly-2026-03-14');

// fake serialised Firestore
const store = new Map(); let chain = Promise.resolve();
const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: (id) => ({
    _id: id, set: async (v, o) => store.set(id, Object.assign({}, o && o.merge ? store.get(id) : {}, v)) }) }) }) }),
  runTransaction(fn) { const r = chain.then(() => fn({
      get: async (ref) => ({ exists: store.has(ref._id), data: () => store.get(ref._id) }),
      set: (ref, v) => store.set(ref._id, v) })); chain = r.catch(() => {}); return r; } };

(async () => {
  // 4 devices race: exactly one winner
  const res = await Promise.all(['A', 'B', 'C', 'D'].map(d => W.claimSlot(db, 'u', 'weekly-2026-11-14', d, 1000)));
  assert.strictEqual(res.filter(Boolean).length, 1);
  // crashed 'sending' is never retried, even much later (maybe sent: no duplicates)
  assert.strictEqual(await W.claimSlot(db, 'u', 'weekly-2026-11-14', 'E', 1000 + 3600e3), false);
  // failed: not before 10 min, then retried, max 3 attempts
  await W.markSlot(db, 'u', 'weekly-2026-11-14', 'failed', 2000, 'boom');
  assert.strictEqual(await W.claimSlot(db, 'u', 'weekly-2026-11-14', 'B', 2000 + 60e3), false);
  assert.strictEqual(await W.claimSlot(db, 'u', 'weekly-2026-11-14', 'B', 2000 + 11 * 60e3), true);
  await W.markSlot(db, 'u', 'weekly-2026-11-14', 'failed', 3e6, 'boom');
  assert.strictEqual(await W.claimSlot(db, 'u', 'weekly-2026-11-14', 'C', 3e6 + 11 * 60e3), true);
  await W.markSlot(db, 'u', 'weekly-2026-11-14', 'failed', 4e6, 'boom');
  assert.strictEqual(await W.claimSlot(db, 'u', 'weekly-2026-11-14', 'D', 4e6 + 3600e3), false); // attempts exhausted
  // sent is final
  await W.claimSlot(db, 'u', 'rem-x', 'A', 1); await W.markSlot(db, 'u', 'rem-x', 'sent', 2);
  assert.strictEqual(await W.claimSlot(db, 'u', 'rem-x', 'B', 9e9), false);
  // reminder pick: overdue + <=48h, max 3; far-future only -> 1
  const now = at('2026-11-11T15:00:00Z');
  const t = (id, d) => ({ id, dueDate: d, dueTime: '12:00' });
  assert.deepStrictEqual(W.pickReminderTasks([t('a', '2026-11-10'), t('b', '2026-11-12'), t('c', '2026-11-12'), t('d', '2026-11-12'), t('far', '2026-12-30')], now).map(x => x.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(W.pickReminderTasks([t('far', '2026-12-30'), t('far2', '2026-12-31')], now).map(x => x.id), ['far']);
  assert.deepStrictEqual(W.pickReminderTasks([{ ...t('x', '2026-11-11'), whatsappRemindersEnabled: false }, { ...t('y', '2026-11-11'), completed: true }], now), []);
  console.log('wa_slots OK');
})().catch(e => { console.error(e); process.exit(1); });
// regression: getWeeklyReportData's default param must not reference a body-local (ReferenceError on manual/print report)
{
  const src = require('fs').readFileSync(__dirname + '/../js/app.jsx', 'utf8');
  const m = src.match(/const getWeeklyReportData = \(([^)]*)\) =>/);
  assert.ok(m && /^u = activeUserData/.test(m[1]), 'getWeeklyReportData signature: ' + (m && m[1]));
}
