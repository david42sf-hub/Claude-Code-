// Sustituto del servidor para la página publicada: misma API que server/index.js,
// pero todo corre en el navegador y los datos se guardan en el espacio privado del usuario.
import { parseTradovateCsv } from '../server/csv.js';
import { parseTradezellaCalendar } from '../server/economic.js';
import { buildTrades } from '../server/engine.js';
import { parseTimestamp, isValidTz } from '../server/time.js';
import { DEFAULT_INSTRUMENTS } from '../server/instruments.js';
import { normalizeRules } from '../public/lib/insights.js';
import { normalizePlaybooks } from '../public/lib/playbooks.js';

const CHUNK = 1200;
const LS_KEY = 'diario-de-trading';

const mem = { tz: 'America/New_York', rules: normalizeRules(), instruments: {}, playbooks: [], fills: [], meta: {}, days: {}, imports: [] };
let col = null;            // colección privada del usuario en la base de datos
let storage = 'none';      // 'db' | 'local' | 'none'
let chunksSaved = 0;
let cache = null;
let ready = null;

const fail = (msg) => { throw new Error(msg); };
const packFill = (f) => [f.id, f.account, f.contract, f.side, f.qty, f.price, f.ts, f.fee, f.source, f.batch || ''];
const unpackFill = (a) => ({ id: a[0], account: a[1], contract: a[2], side: a[3], qty: a[4], price: a[5], ts: a[6], fee: a[7] ?? null, source: a[8], batch: a[9] ?? '' });

function instrumentList() {
  const map = new Map(DEFAULT_INSTRUMENTS.map(([root, name, multiplier]) => [root, { root, name, multiplier, fee: 0 }]));
  for (const [root, v] of Object.entries(mem.instruments)) map.set(root, { root, name: v.name || map.get(root)?.name || '', multiplier: v.multiplier, fee: v.fee });
  return [...map.values()].sort((a, b) => a.root.localeCompare(b.root));
}

// ---------- guardado ----------
const queues = new Map();
function write(id, body) {
  if (storage === 'local') {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ ...mem, fills: mem.fills.map(packFill) })); } catch { /* sin almacenamiento */ }
    return Promise.resolve();
  }
  if (storage !== 'db') return Promise.resolve();
  // una escritura a la vez por documento
  const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(() => (body === null ? col.doc(id).delete() : col.doc(id).set(body)));
  queues.set(id, next);
  return next;
}
const saveConfig = () => write('config', { tz: mem.tz, rules: mem.rules, instruments: mem.instruments, playbooks: mem.playbooks, imports: mem.imports });
const saveMeta = () => write('meta', { byId: mem.meta });
const saveDays = () => write('days', { notes: mem.days });
async function saveFills() {
  const packed = mem.fills.map(packFill);
  const n = Math.ceil(packed.length / CHUNK);
  const jobs = [];
  for (let i = 0; i < n; i++) jobs.push(write(`fills-${i}`, { rows: packed.slice(i * CHUNK, (i + 1) * CHUNK) }));
  for (let i = n; i < chunksSaved; i++) jobs.push(write(`fills-${i}`, null));
  chunksSaved = n;
  await Promise.all(jobs);
}

function absorb(docs) {
  const rows = [];
  for (const [id, d] of docs) {
    if (id === 'config') {
      if (isValidTz(d.tz)) mem.tz = d.tz;
      mem.rules = normalizeRules(d.rules); mem.instruments = d.instruments || {}; mem.playbooks = normalizePlaybooks(d.playbooks);
      mem.imports = Array.isArray(d.imports) ? d.imports : [];
    } else if (id === 'meta') mem.meta = d.byId || {};
    else if (id === 'days') mem.days = d.notes || {};
    else if (/^fills-\d+$/.test(id)) { rows.push(...(d.rows || [])); chunksSaved = Math.max(chunksSaved, +id.slice(6) + 1); }
  }
  mem.fills = rows.map(unpackFill);
}

async function init() {
  const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
  try {
    const use = globalThis.claude?.use;
    if (use) {
      const [db, user] = await Promise.race([Promise.all([use('db'), use('user')]), timeout(10000).then(() => [null, null])]);
      const uid = db && user ? await user.id() : null;
      if (uid) {
        const ref = db.collection(`data/users/${uid}`);
        const snap = await Promise.race([ref.get(), timeout(10000)]);
        if (snap) { absorb(snap.docs.map((d) => [d.id, d.data()])); col = ref; storage = 'db'; }
      }
    }
  } catch { /* se usa el respaldo local */ }
  if (storage === 'none') {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        Object.assign(mem, d, { fills: (d.fills || []).map(unpackFill), rules: normalizeRules(d.rules), playbooks: normalizePlaybooks(d.playbooks) });
      }
      localStorage.setItem(`${LS_KEY}-probe`, '1');
      storage = 'local';
    } catch { storage = 'none'; }
  }
}

// ---------- operaciones ----------
function trades() {
  if (cache) return cache;
  const inst = new Map(instrumentList().map((i) => [i.root, i]));
  cache = buildTrades(mem.fills, inst, mem.tz).map((t) => {
    const m = mem.meta[t.id] || {};
    return {
      ...t, notes: m.notes || '', strategy: m.strategy || '', tags: m.tags || [], mistakes: m.mistakes || [],
      stop: m.stop ?? null, shots: [], playbook: m.playbook || '', followed: m.followed || [],
    };
  });
  return cache;
}
function addFills(list, batch = '') {
  const known = new Set(mem.fills.map((f) => f.id));
  let added = 0, duplicates = 0;
  for (const f of list) { if (known.has(f.id)) duplicates++; else { known.add(f.id); mem.fills.push({ ...f, batch }); added++; } }
  cache = null;
  return { added, duplicates };
}

/** Archivos importados con las ejecuciones que conservan, del más reciente al más antiguo. */
function importList() {
  const counts = new Map();
  for (const f of mem.fills) counts.set(f.batch || (f.source === 'csv' ? 'legacy' : ''), (counts.get(f.batch || (f.source === 'csv' ? 'legacy' : '')) || 0) + 1);
  const out = mem.imports.map((i) => ({ ...i, fills: counts.get(i.id) || 0 })).filter((i) => i.fills > 0).reverse();
  if (counts.get('legacy')) out.push({ id: 'legacy', name: 'Importaciones anteriores', at: null, added: counts.get('legacy'), fills: counts.get('legacy') });
  return out;
}

function state() {
  return {
    settings: { tz: mem.tz, rules: mem.rules, playbooks: mem.playbooks }, instruments: instrumentList(), days: mem.days,
    sync: { configured: false }, fills: mem.fills.length, passwordProtected: false, imports: importList(),
    features: { shots: false, sync: false, economicConsent: true },
    storageNote: storage === 'db' ? '' : storage === 'local'
      ? 'No se pudo abrir tu espacio de datos en Claude, así que los cambios se guardan solo en este navegador.'
      : 'No hay dónde guardar en esta vista: los cambios se perderán al cerrar la página.',
    dataNote: `${mem.fills.length} ejecuciones guardadas en tu espacio privado de esta página. Solo tú puedes verlas, aunque compartas el enlace.`,
  };
}

const MCP_ERRORS = {
  needs_reauth: 'Vuelve a conectar Tradezella en Claude (Ajustes → Conectores) y reintenta.',
  server_not_connected: 'No tienes el conector de Tradezella añadido en Claude, así que el calendario no está disponible.',
  approval_required: 'Hace falta tu permiso para consultar el calendario. Pulsa el botón de nuevo y acéptalo cuando Claude lo pida.',
  blocked_by_policy: 'Tu organización no permite este conector.',
};

/** Calendario económico desde el conector de Tradezella. Solo pide fechas, impacto y país: nunca lee tus operaciones. */
async function economic(q) {
  const base = { source: 'Tradezella', coverage: 'range', note: 'Las horas están en la zona horaria configurada en tu cuenta de Tradezella.' };
  let mcp = null;
  try { mcp = await globalThis.claude?.use?.('mcp'); } catch { mcp = null; }
  if (!mcp) return { ...base, events: [], error: 'Esta vista no puede conectarse a Tradezella. Abre la página en claude.ai para usar el calendario.' };
  const input = { start_date: q.get('from'), end_date: q.get('to') };
  if (q.get('impact')) input.impact = q.get('impact');
  if (q.get('countries')) input.countries = q.get('countries');
  try {
    const r = await mcp.callTool('Tradezella', 'get_economic_calendar', input);
    const text = typeof r?.payload === 'string' ? r.payload
      : (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { ...base, events: parseTradezellaCalendar(text) };
  } catch (e) {
    return { ...base, events: [], error: MCP_ERRORS[e?.code] || `No se pudo consultar el calendario de Tradezella (${e?.code || 'error'}).` };
  }
}

async function handle(method, url, body = {}) {
  await (ready ||= init());
  const [path, qs] = url.split('?');
  const p = path.replace(/^\/api/, '');
  let m;
  if (p === '/state' && method === 'GET') return state();
  if (p === '/trades' && method === 'GET') return trades();
  if (p === '/economic' && method === 'GET') return economic(new URLSearchParams(qs || ''));

  if (p === '/import' && method === 'POST') {
    const parsed = parseTradovateCsv(body.csv || '', { tz: mem.tz, account: String(body.account || '').trim() || 'Tradovate' });
    const known = new Set(instrumentList().map((i) => i.root));
    const newInstruments = [];
    for (const [root, mult] of Object.entries(parsed.derivedMultipliers)) {
      if (!known.has(root) && mult > 0) { mem.instruments[root] = { name: '', multiplier: mult, fee: 0 }; newInstruments.push(root); }
    }
    const batch = `imp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const { added, duplicates } = addFills(parsed.fills, batch);
    if (added) { mem.imports = [...mem.imports, { id: batch, name: String(body.name || 'archivo.csv').slice(0, 200), at: new Date().toISOString(), added }].slice(-200); await saveFills(); }
    if (added || newInstruments.length) await saveConfig();
    const unknown = [...new Set(trades().filter((t) => t.unknownInstrument).map((t) => t.root))];
    return { format: parsed.format, added, duplicates, warnings: parsed.warnings, newInstruments, unknown, trades: trades().length };
  }

  if (p === '/trades' && method === 'POST') {
    const contract = String(body.contract || '').trim().toUpperCase();
    const qty = Number(body.qty), entry = Number(body.entryPrice), exit = Number(body.exitPrice);
    const t0 = parseTimestamp(body.entryTime, mem.tz), t1 = parseTimestamp(body.exitTime, mem.tz);
    if (!contract) fail('Falta el contrato.');
    if (!(qty > 0) || !isFinite(entry) || !isFinite(exit)) fail('Revisa cantidad y precios.');
    if (!t0 || !t1 || t1 < t0) fail('Revisa las fechas de entrada y salida.');
    const long = body.side !== 'short';
    const fees = Number(body.fees);
    const fee = body.fees !== '' && body.fees != null && isFinite(fees) && fees >= 0 ? fees / 2 : null;
    const id = `m-${crypto.randomUUID()}`;
    const account = String(body.account || '').trim() || 'Manual';
    addFills([
      { id: `${id}-a`, account, contract, side: long ? 'B' : 'S', qty, price: entry, ts: t0.toISOString(), fee, source: 'manual' },
      { id: `${id}-b`, account, contract, side: long ? 'S' : 'B', qty, price: exit, ts: t1.toISOString(), fee, source: 'manual' },
    ]);
    await saveFills();
    return { ok: true };
  }

  if (p === '/trades/delete' && method === 'POST') {
    const want = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
    if (!want.size) fail('No hay operaciones seleccionadas.');
    const hit = trades().filter((t) => want.has(t.id));
    const gone = new Set(hit.flatMap((t) => t.legs.map((l) => l.id)));
    mem.fills = mem.fills.filter((f) => !gone.has(f.id));
    for (const t of hit) delete mem.meta[t.id];
    cache = null;
    await Promise.all([saveFills(), saveMeta(), saveConfig()]);
    return { deleted: hit.length };
  }
  if ((m = /^\/imports\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const before = new Set(trades().map((t) => t.id));
    const n = mem.fills.length;
    mem.fills = mem.fills.filter((f) => !(id === 'legacy' ? !f.batch && f.source === 'csv' : f.batch === id));
    mem.imports = mem.imports.filter((i) => i.id !== id);
    cache = null;
    const after = new Set(trades().map((t) => t.id));
    const goneTrades = [...before].filter((x) => !after.has(x));
    for (const t of goneTrades) delete mem.meta[t];
    await Promise.all([saveFills(), saveMeta(), saveConfig()]);
    return { fills: n - mem.fills.length, trades: goneTrades.length };
  }
  if ((m = /^\/trades\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const t = trades().find((x) => x.id === id) || fail('Operación no encontrada.');
    const gone = new Set(t.legs.map((l) => l.id));
    mem.fills = mem.fills.filter((f) => !gone.has(f.id));
    delete mem.meta[id];
    cache = null;
    await Promise.all([saveFills(), saveMeta()]);
    return { ok: true };
  }

  if ((m = /^\/trades\/([^/]+)\/meta$/.exec(p)) && method === 'PUT') {
    const id = decodeURIComponent(m[1]);
    const t = trades().find((x) => x.id === id) || fail('Operación no encontrada.');
    const list = (v, max = 30) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
    mem.meta[id] = {
      notes: body.notes !== undefined ? String(body.notes).slice(0, 20000) : t.notes,
      strategy: body.strategy !== undefined ? String(body.strategy).trim().slice(0, 80) : t.strategy,
      tags: body.tags !== undefined ? list(body.tags) : t.tags,
      mistakes: body.mistakes !== undefined ? list(body.mistakes) : t.mistakes,
      stop: body.stop !== undefined ? (body.stop === null || body.stop === '' || !isFinite(+body.stop) ? null : +body.stop) : t.stop,
      playbook: body.playbook !== undefined ? String(body.playbook).trim().slice(0, 40) : t.playbook,
      followed: body.followed !== undefined ? list(body.followed, 100) : t.followed,
    };
    cache = null;
    await saveMeta();
    return trades().find((x) => x.id === id);
  }

  if ((m = /^\/days\/(\d{4}-\d{2}-\d{2})$/.exec(p)) && method === 'PUT') {
    const notes = String(body.notes ?? '').slice(0, 20000);
    if (notes) mem.days[m[1]] = notes; else delete mem.days[m[1]];
    await saveDays();
    return { ok: true };
  }
  if (p === '/settings' && method === 'PUT') {
    if (body.tz !== undefined) {
      if (!isValidTz(body.tz)) fail('Zona horaria no válida.');
      mem.tz = body.tz; cache = null;
    }
    if (body.rules !== undefined) mem.rules = normalizeRules(body.rules);
    if (body.playbooks !== undefined) mem.playbooks = normalizePlaybooks(body.playbooks);
    await saveConfig();
    return state();
  }
  if ((m = /^\/instruments\/([^/]+)$/.exec(p)) && method === 'PUT') {
    const root = decodeURIComponent(m[1]).trim().toUpperCase();
    const multiplier = Number(body.multiplier), fee = Number(body.fee);
    if (!root) fail('Falta el símbolo.');
    if (!(multiplier > 0)) fail('El valor por punto debe ser mayor que cero.');
    if (!(fee >= 0)) fail('La comisión no puede ser negativa.');
    mem.instruments[root] = { name: mem.instruments[root]?.name || '', multiplier, fee };
    cache = null;
    await saveConfig();
    return state();
  }
  // Borra operaciones, notas y playbooks. Los ajustes (zona horaria, instrumentos, reglas) se conservan.
  if (p === '/data' && method === 'DELETE') {
    if (body.confirm !== 'BORRAR') fail('Falta la confirmación.');
    mem.fills = []; mem.meta = {}; mem.days = {}; mem.playbooks = []; mem.imports = [];
    // vuelve a los instrumentos por defecto (conserva las comisiones de esos)
    const keep = new Set(DEFAULT_INSTRUMENTS.map((i) => i[0]));
    mem.instruments = Object.fromEntries(Object.entries(mem.instruments).filter(([root]) => keep.has(root)));
    cache = null;
    await Promise.all([saveFills(), saveMeta(), saveDays(), saveConfig()]);
    return state();
  }
  fail('Esta función no está disponible en esta página.');
}

globalThis.LOCAL_BACKEND = async (method, url, body) => {
  try { return await handle(method, url, body); } catch (e) {
    if (e?.code === 'quota_exceeded') throw new Error('Se llenó el espacio de datos de esta página. Elimina operaciones antiguas para seguir guardando.');
    if (e?.code) throw new Error('No se pudo guardar el cambio. Revisa tu conexión e inténtalo de nuevo.');
    throw e;
  }
};
