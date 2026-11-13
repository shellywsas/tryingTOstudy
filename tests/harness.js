// Tiny test harness: each test() guards a named bug. No deps, no async.
const stats = { pass: 0, fail: 0, failures: [] };
function test(name, fn) {
    try { fn(); stats.pass++; console.log('[PASS] ' + name); }
    catch (e) { stats.fail++; stats.failures.push(name); console.log('[FAIL] ' + name + '\n   ' + (e && e.message)); }
}
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
module.exports = { test, stats, mulberry32 };
