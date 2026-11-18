// Empaqueta la app en una sola página HTML (sin servidor) para publicarla como página independiente.
// Uso: node scripts/build-artifact.mjs [salida.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'diario-de-trading.html'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Orden de dependencias: cada módulo se envuelve en una función y expone sus exportaciones.
const MODULES = [
  'server/time.js', 'server/instruments.js', 'server/csv.js', 'server/engine.js',
  'public/lib/stats.js', 'public/lib/insights.js', 'public/charts.js', 'artifact/backend.js', 'public/app.js',
];

function wrap(file) {
  const names = [];
  let code = read(file)
    .replace(/^import\s*\{([^}]+)\}\s*from\s*'([^']+)';?[ \t]*$/gm, (_, list, from) => `const {${list}} = M['${path.basename(from)}'];`)
    .replace(/^export\s+((?:async\s+)?(?:function\*?|const|class|let)\s+([A-Za-z_$][\w$]*))/gm, (_, decl, name) => { names.push(name); return decl; });
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`Quedó un import/export sin convertir en ${file}`);
  if (code.includes('</script')) throw new Error(`${file} contiene </script`);
  return `M['${path.basename(file)}'] = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();`;
}

// Tema: la página publicada sigue el tema del visor, así que la paleta clara también
// se aplica cuando el sistema está en claro y no hay una elección explícita.
let css = read('public/styles.css');
const light = /:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css);
if (!light) throw new Error('No encontré la paleta clara en styles.css');
css += `
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {${light[1]}} }
:root[data-theme="dark"] { color-scheme: dark; }
html, body { height: auto; }
.shell { min-height: 100vh; }
@media (max-width: 860px) {
  .side { top: env(safe-area-inset-top, 0px); }
  body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 30; background: var(--surface); }
}
`;

const html = `<title>Diario de trading</title>
<style>
${css}</style>
<div id="app"></div>
<div id="tip" class="tip" hidden></div>
<div id="toast" class="toast" hidden role="status"></div>
<script>
try { const t = localStorage.getItem('tema'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch {}
</script>
<script type="module">
const M = {};
${MODULES.map(wrap).join('\n\n')}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out} (${(html.length / 1024).toFixed(0)} KB)`);
