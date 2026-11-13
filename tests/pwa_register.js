// SW registration is gated: not before the first Firestore answer, once only, 20 s fallback after load.
const assert = require('assert'), fs = require('fs'), vm = require('vm');
function run(fire) {
    const L = {}, timers = []; let registered = 0;
    const win = { addEventListener: (n, f) => { (L[n] = L[n] || []).push(f); }, __BUILD_ID: 'b1', location: { reload() {} } };
    const nav = { serviceWorker: { addEventListener() {}, register: () => { registered++; return new Promise(() => {}); } }, onLine: true };
    const ctx = { window: win, navigator: nav, document: { addEventListener() {}, querySelector: () => null }, setTimeout: (f, ms) => timers.push({ f, ms }), setInterval() {}, localStorage: { getItem: () => null, length: 0 }, sessionStorage: { getItem: () => null, setItem() {} }, fetch: () => Promise.resolve({ ok: false }), console };
    vm.createContext(ctx); vm.runInContext(fs.readFileSync(__dirname + '/../js/pwa.js', 'utf8'), ctx);
    (L.load || []).forEach(f => f());
    assert.strictEqual(registered, 0, 'not registered right after load');
    fire(L, timers);
    return registered;
}
assert.strictEqual(run((L) => { L['ss-first-sync'].forEach(f => f()); L['ss-first-sync'].forEach(f => f()); }), 1, 'registers once on the first Firestore answer');
assert.strictEqual(run((L, t) => { t.filter(x => x.ms === 20000).forEach(x => x.f()); }), 1, 'fallback registers after 20 s');
assert.strictEqual(run((L, t) => { L['ss-first-sync'].forEach(f => f()); t.filter(x => x.ms === 20000).forEach(x => x.f()); }), 1, 'event + fallback register only once');
console.log('pwa_register: 3 passed');
