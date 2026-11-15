// Sustituto del servidor para la página publicada: misma API que server/index.js,
// pero todo corre en el navegador y los datos se guardan en el espacio privado del usuario.
import { parseTradovateCsv } from './csv.js';
import { buildTrades } from './engine.js';
import { parseTimestamp, isValidTz } from './time.js';
import { DEFAULT_INSTRUMENTS } from './instruments.js';

const CHUNK = 1200;
const LS_KEY = 'diario-de-trading';

const mem = { tz: 'America/New_York', instruments: {}, fills: [], meta: {}, days: {} };
let example = [];          // ejecuciones de ejemplo (nunca se guardan)
let exampleMeta = {};
let col = null;            // colección privada del usuario en la base de datos
let storage = 'none';      // 'db' | 'local' | 'none'
let chunksSaved = 0;
let cache = null;
let ready = null;

const fail = (msg) => { throw new Error(msg); };
const packFill = (f) => [f.id, f.account, f.contract, f.side, f.qty, f.price, f.ts, f.fee, f.source];
const unpackFill = (a) => ({ id: a[0], account: a[1], contract: a[2], side: a[3], qty: a[4], price: a[5], ts: a[6], fee: a[7] ?? null, source: a[8] });

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
const saveConfig = () => write('config', { tz: mem.tz, instruments: mem.instruments });
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
    if (id === 'config') { if (isValidTz(d.tz)) mem.tz = d.tz; mem.instruments = d.instruments || {}; }
    else if (id === 'meta') mem.meta = d.byId || {};
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
      if (raw) { const d = JSON.parse(raw); Object.assign(mem, d, { fills: (d.fills || []).map(unpackFill) }); }
      localStorage.setItem(`${LS_KEY}-probe`, '1');
      storage = 'local';
    } catch { storage = 'none'; }
  }
  if (!mem.fills.length) makeExample();
}

// ---------- datos de ejemplo ----------
function makeExample() {
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const specs = { MNQ: [20500, 0.25, 1, 0.79], MES: [5900, 0.25, 0.25, 0.79], MGC: [2650, 0.1, 0.15, 1.09] };
  const now = new Date();
  const letter = 'FGHJKMNQUVXZ'[[2, 2, 2, 5, 5, 5, 8, 8, 8, 11, 11, 11][now.getUTCMonth()]];
  const suffix = `${letter}${now.getUTCFullYear() % 10}`;
  const fills = [];
  let n = 0;
  for (let back = 75; back >= 1; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    if ([0, 6].includes(d.getUTCDay()) || rnd() < 0.12) continue;
    const count = 1 + Math.floor(rnd() * 4);
    let clock = 14 * 3600 + 35 * 60;
    for (let k = 0; k < count; k++) {
      const root = rnd() < 0.6 ? 'MNQ' : rnd() < 0.7 ? 'MES' : 'MGC';
      const [base, tick, scale, fee] = specs[root];
      const qty = 1 + Math.floor(rnd() * 3), long = rnd() < 0.55;
      const entry = Math.round((base + (rnd() - 0.5) * base * 0.03) / tick) * tick;
      const move = Math.round(((rnd() < 0.56 ? 8 + rnd() * 40 : -(6 + rnd() * 28)) * scale) / tick) * tick;
      const exit = entry + (long ? move : -move);
      clock += 120 + Math.floor(rnd() * 3600);
      const dur = 20 + Math.floor(rnd() * rnd() * 2400);
      const at = (s) => new Date(d.getTime() + s * 1000).toISOString();
      const mk = (side, price, ts) => ({ id: `ej-${++n}`, account: 'Ejemplo', contract: root + suffix, side, qty, price: +price.toFixed(2), ts, fee: fee * qty, source: 'manual' });
      fills.push(mk(long ? 'B' : 'S', entry, at(clock)), mk(long ? 'S' : 'B', exit, at(clock + dur)));
      clock += dur;
    }
  }
  example = fills;
  exampleMeta = {};
  const names = ['Ruptura de apertura', 'Reversión a VWAP', 'Continuación de tendencia'];
  buildTrades(fills, new Map(instrumentList().map((i) => [i.root, i])), mem.tz).forEach((t, i) => {
    if (i % 2) return;
    exampleMeta[t.id] = {
      strategy: names[i % 3], tags: [i % 4 ? 'A+' : 'B'], mistakes: t.net < 0 && i % 3 ? ['Entrada tardía'] : [],
      stop: t.entryPrice + (t.side === 'long' ? -12 : 12) * (t.root === 'MNQ' ? 1 : 0.25), notes: i % 6 ? '' : 'Buena lectura del contexto.',
    };
  });
}
const usingExample = () => example.length > 0;
function dropExample() { if (usingExample()) { example = []; exampleMeta = {}; cache = null; } }

// ---------- operaciones ----------
function trades() {
  if (cache) return cache;
  const inst = new Map(instrumentList().map((i) => [i.root, i]));
  const metas = usingExample() ? exampleMeta : mem.meta;
  cache = buildTrades(usingExample() ? example : mem.fills, inst, mem.tz).map((t) => {
    const m = metas[t.id] || {};
    return { ...t, notes: m.notes || '', strategy: m.strategy || '', tags: m.tags || [], mistakes: m.mistakes || [], stop: m.stop ?? null, shots: [] };
  });
  return cache;
}
function addFills(list) {
  const known = new Set(mem.fills.map((f) => f.id));
  let added = 0, duplicates = 0;
  for (const f of list) { if (known.has(f.id)) duplicates++; else { known.add(f.id); mem.fills.push(f); added++; } }
  cache = null;
  return { added, duplicates };
}

function state() {
  return {
    settings: { tz: mem.tz }, instruments: instrumentList(), days: usingExample() ? {} : mem.days,
    sync: { configured: false }, fills: mem.fills.length, passwordProtected: false, example: usingExample(),
    features: { shots: false, sync: false },
    storageNote: storage === 'db' ? '' : storage === 'local'
      ? 'No se pudo abrir tu espacio de datos en Claude, así que los cambios se guardan solo en este navegador.'
      : 'No hay dónde guardar en esta vista: los cambios se perderán al cerrar la página.',
    dataNote: `${mem.fills.length} ejecuciones guardadas en tu espacio privado de esta página. Solo tú puedes verlas, aunque compartas el enlace.`,
  };
}

async function handle(method, url, body = {}) {
  await (ready ||= init());
  const p = url.replace(/^\/api/, '');
  let m;
  if (p === '/state' && method === 'GET') return state();
  if (p === '/trades' && method === 'GET') return trades();

  if (p === '/import' && method === 'POST') {
    const parsed = parseTradovateCsv(body.csv || '', { tz: mem.tz, account: String(body.account || '').trim() || 'Tradovate' });
    dropExample();
    const known = new Set(instrumentList().map((i) => i.root));
    const newInstruments = [];
    for (const [root, mult] of Object.entries(parsed.derivedMultipliers)) {
      if (!known.has(root) && mult > 0) { mem.instruments[root] = { name: '', multiplier: mult, fee: 0 }; newInstruments.push(root); }
    }
    const { added, duplicates } = addFills(parsed.fills);
    if (added) await saveFills();
    if (newInstruments.length) await saveConfig();
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
    dropExample();
    addFills([
      { id: `${id}-a`, account, contract, side: long ? 'B' : 'S', qty, price: entry, ts: t0.toISOString(), fee, source: 'manual' },
      { id: `${id}-b`, account, contract, side: long ? 'S' : 'B', qty, price: exit, ts: t1.toISOString(), fee, source: 'manual' },
    ]);
    await saveFills();
    return { ok: true };
  }

  if ((m = /^\/trades\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    const t = trades().find((x) => x.id === id) || fail('Operación no encontrada.');
    const gone = new Set(t.legs.map((l) => l.id));
    if (usingExample()) { example = example.filter((f) => !gone.has(f.id)); cache = null; return { ok: true }; }
    mem.fills = mem.fills.filter((f) => !gone.has(f.id));
    delete mem.meta[id];
    cache = null;
    await Promise.all([saveFills(), saveMeta()]);
    return { ok: true };
  }

  if ((m = /^\/trades\/([^/]+)\/meta$/.exec(p)) && method === 'PUT') {
    const id = decodeURIComponent(m[1]);
    const t = trades().find((x) => x.id === id) || fail('Operación no encontrada.');
    const list = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
    const next = {
      notes: body.notes !== undefined ? String(body.notes).slice(0, 20000) : t.notes,
      strategy: body.strategy !== undefined ? String(body.strategy).trim().slice(0, 80) : t.strategy,
      tags: body.tags !== undefined ? list(body.tags) : t.tags,
      mistakes: body.mistakes !== undefined ? list(body.mistakes) : t.mistakes,
      stop: body.stop !== undefined ? (body.stop === null || body.stop === '' || !isFinite(+body.stop) ? null : +body.stop) : t.stop,
    };
    (usingExample() ? exampleMeta : mem.meta)[id] = next;
    cache = null;
    if (!usingExample()) await saveMeta();
    return trades().find((x) => x.id === id);
  }

  if ((m = /^\/days\/(\d{4}-\d{2}-\d{2})$/.exec(p)) && method === 'PUT') {
    if (usingExample()) fail('Importa tus operaciones para guardar notas del día.');
    const notes = String(body.notes ?? '').slice(0, 20000);
    if (notes) mem.days[m[1]] = notes; else delete mem.days[m[1]];
    await saveDays();
    return { ok: true };
  }
  if (p === '/settings' && method === 'PUT') {
    if (!isValidTz(body.tz)) fail('Zona horaria no válida.');
    mem.tz = body.tz; cache = null;
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
  fail('Esta función no está disponible en esta página.');
}

globalThis.LOCAL_BACKEND = async (method, url, body) => {
  try { return await handle(method, url, body); } catch (e) {
    if (e?.code === 'quota_exceeded') throw new Error('Se llenó el espacio de datos de esta página. Elimina operaciones antiguas para seguir guardando.');
    if (e?.code) throw new Error('No se pudo guardar el cambio. Revisa tu conexión e inténtalo de nuevo.');
    throw e;
  }
};
