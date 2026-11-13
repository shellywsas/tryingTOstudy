// Crash sweep (syntax): node --check on plain JS; JSX parsed with a TypeScript/Babel already on this machine (never installed).
const fs = require('fs'), path = require('path'), cp = require('child_process');
let n = 0, failed = 0;
for (const f of fs.readdirSync('js').filter((x) => x.endsWith('.js')).concat(['sw.js'].map((x) => '../' + x))) {
    const p = path.join('js', f);
    const r = cp.spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    n++; if (r.status !== 0) { failed++; console.error('[FAIL] node --check ' + p + '\n' + r.stderr); }
}
const candidates = [
    '@babel/core',
    '/Applications/Cursor.app/Contents/Resources/app/extensions/node_modules/typescript/lib/typescript.js',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/node_modules/typescript/lib/typescript.js',
];
let ts = null, babel = null;
try { babel = require('@babel/core'); } catch (e) {}
if (!babel) for (const c of candidates.slice(1)) { try { ts = require(c); break; } catch (e) {} }
if (!babel && !ts) console.log('[SKIP] no JSX parser available (@babel/core / typescript not installed): app.jsx not parsed');
else for (const f of ['js/app.jsx', 'js/icons.jsx']) {
    const src = fs.readFileSync(f, 'utf8'); n++;
    let errs = [];
    if (babel) { try { babel.transformSync(src, { presets: [], plugins: ['@babel/plugin-syntax-jsx'], filename: f }); } catch (e) { errs.push(String(e.message)); } }
    else {
        const out = ts.transpileModule(src, { fileName: f, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, target: ts.ScriptTarget.ES2020 } });
        errs = (out.diagnostics || []).map((d) => { const lc = d.file ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }; return `${f}:${lc.line + 1}:${lc.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`; });
    }
    if (errs.length) { failed++; console.error('[FAIL] ' + f + '\n' + errs.slice(0, 10).join('\n')); }
}
console.log(`syntax: ${n - failed}/${n} ok`);
process.exit(failed ? 1 : 0);
