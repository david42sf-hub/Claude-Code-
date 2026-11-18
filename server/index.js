import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { parseTradovateCsv } from './csv.js';
import { parseTimestamp } from './time.js';
import { TradovateSync, tradovateConfig } from './tradovate.js';
import { PUBLIC_FEED, mapPublicFeed, filterEvents } from './economic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
const SHOT_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export function createApp({ dataDir, password = '', tradovate = tradovateConfig({}), fetchImpl } = {}) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const store = new Store(path.join(dataDir, 'diario.db'));
  const sync = new TradovateSync(tradovate, store, fetchImpl);
  const doFetch = fetchImpl || fetch;
  let feedCache = null;   // el feed público cambia poco: se guarda 30 minutos
  const publicDir = path.join(ROOT, 'public');
  const uploadsDir = path.join(dataDir, 'uploads');
  const sessionToken = password
    ? crypto.createHmac('sha256', password).update('diario-de-trading-session').digest('hex') : '';

  const authed = (req) => {
    if (!password) return true;
    const m = /(?:^|;\s*)tj=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    return !!m && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(sessionToken));
  };

  const readBody = (req, limit = 20 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'El archivo es demasiado grande.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'JSON no válido.')); }
    });
    req.on('error', reject);
  });

  const send = (res, status, body, headers = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  };

  const serveFile = (res, baseDir, rel) => {
    const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + rel));
    if (file !== baseDir && !file.startsWith(baseDir + path.sep)) throw new HttpError(403, 'Acceso denegado.');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'No encontrado.');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  };

  const state = () => ({
    settings: store.settings(), instruments: store.instruments(), days: store.days(),
    sync: sync.status, fills: store.fillCount(), passwordProtected: !!password, imports: store.imports(),
  });

  async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api/, '');
    const m = req.method;

    if (p === '/login' && m === 'POST') {
      const { password: given = '' } = await readBody(req, 4096);
      const a = crypto.createHash('sha256').update(String(given)).digest();
      const b = crypto.createHash('sha256').update(password).digest();
      if (!password || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Contraseña incorrecta.');
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `tj=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`,
      });
    }
    if (!authed(req)) throw new HttpError(401, 'Inicia sesión.');
    if (p === '/logout' && m === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'tj=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (p === '/state' && m === 'GET') return send(res, 200, state());
    if (p === '/trades' && m === 'GET') return send(res, 200, store.trades());

    if (p === '/import' && m === 'POST') {
      const { csv, account, name } = await readBody(req);
      if (!csv) throw new HttpError(400, 'Falta el contenido del archivo.');
      let parsed;
      try {
        parsed = parseTradovateCsv(csv, { tz: store.settings().tz, account: String(account || '').trim() || 'Tradovate' });
      } catch (e) { throw new HttpError(400, e.message); }
      const newInstruments = store.addMissingInstruments(parsed.derivedMultipliers);
      const { added, duplicates } = store.addFills(parsed.fills, { batch: 'pending' });
      if (added) { const id = store.recordImport(name, added); store.relabelBatch('pending', id); }
      else store.relabelBatch('pending', '');
      const unknown = [...new Set(store.trades().filter((t) => t.unknownInstrument).map((t) => t.root))];
      return send(res, 200, {
        format: parsed.format, added, duplicates, warnings: parsed.warnings, newInstruments, unknown,
        trades: store.trades().length,
      });
    }

    if (p === '/trades' && m === 'POST') {
      const b = await readBody(req);
      const tz = store.settings().tz;
      const contract = String(b.contract || '').trim().toUpperCase();
      const qty = Number(b.qty), entry = Number(b.entryPrice), exit = Number(b.exitPrice);
      const t0 = parseTimestamp(b.entryTime, tz), t1 = parseTimestamp(b.exitTime, tz);
      if (!contract) throw new HttpError(400, 'Falta el contrato.');
      if (!(qty > 0) || !isFinite(entry) || !isFinite(exit)) throw new HttpError(400, 'Revisa cantidad y precios.');
      if (!t0 || !t1 || t1 < t0) throw new HttpError(400, 'Revisa las fechas de entrada y salida.');
      const long = b.side !== 'short';
      const fees = Number(b.fees);
      const fee = isFinite(fees) && fees >= 0 && b.fees !== '' && b.fees != null ? fees / 2 : null;
      const id = `m-${crypto.randomUUID()}`;
      const account = String(b.account || '').trim() || 'Manual';
      store.addFills([
        { id: `${id}-a`, account, contract, side: long ? 'B' : 'S', qty, price: entry, ts: t0.toISOString(), fee, source: 'manual' },
        { id: `${id}-b`, account, contract, side: long ? 'S' : 'B', qty, price: exit, ts: t1.toISOString(), fee, source: 'manual' },
      ]);
      return send(res, 201, { ok: true });
    }

    if (p === '/trades/delete' && m === 'POST') {
      const { ids } = await readBody(req);
      if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'No hay operaciones seleccionadas.');
      const r = store.deleteTrades(ids);
      for (const s of r.shots) fs.rmSync(path.join(uploadsDir, path.basename(s)), { force: true });
      return send(res, 200, { deleted: r.deleted });
    }

    let mm;
    if ((mm = /^\/imports\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      const r = store.deleteImport(decodeURIComponent(mm[1]));
      for (const s of r.shots) fs.rmSync(path.join(uploadsDir, path.basename(s)), { force: true });
      return send(res, 200, { fills: r.fills, trades: r.trades });
    }
    if ((mm = /^\/trades\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      const t = store.deleteTrade(decodeURIComponent(mm[1]));
      for (const s of t.shots) fs.rmSync(path.join(uploadsDir, path.basename(s)), { force: true });
      return send(res, 200, { ok: true });
    }
    if ((mm = /^\/trades\/([^/]+)\/meta$/.exec(p)) && m === 'PUT') {
      const { notes, strategy, tags, mistakes, stop, playbook, followed } = await readBody(req);
      return send(res, 200, store.setMeta(decodeURIComponent(mm[1]), { notes, strategy, tags, mistakes, stop, playbook, followed }));
    }
    if ((mm = /^\/trades\/([^/]+)\/shots$/.exec(p)) && m === 'POST') {
      const id = decodeURIComponent(mm[1]);
      const t = store.trade(id);
      if (!t) throw new HttpError(404, 'Operación no encontrada.');
      const { dataUrl = '' } = await readBody(req);
      const d = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!d) throw new HttpError(400, 'Solo se admiten imágenes PNG, JPG o WebP.');
      if (t.shots.length >= 12) throw new HttpError(400, 'Máximo 12 capturas por operación.');
      const name = `${crypto.randomUUID()}${SHOT_TYPES[d[1]]}`;
      fs.writeFileSync(path.join(uploadsDir, name), Buffer.from(d[2], 'base64'));
      return send(res, 201, store.setMeta(id, { shots: [...t.shots, name] }));
    }
    if ((mm = /^\/trades\/([^/]+)\/shots\/([^/]+)$/.exec(p)) && m === 'DELETE') {
      const id = decodeURIComponent(mm[1]); const name = path.basename(decodeURIComponent(mm[2]));
      const t = store.trade(id);
      if (!t || !t.shots.includes(name)) throw new HttpError(404, 'Captura no encontrada.');
      fs.rmSync(path.join(uploadsDir, name), { force: true });
      return send(res, 200, store.setMeta(id, { shots: t.shots.filter((s) => s !== name) }));
    }

    if ((mm = /^\/days\/(\d{4}-\d{2}-\d{2})$/.exec(p)) && m === 'PUT') {
      const { notes } = await readBody(req);
      store.setDay(mm[1], notes);
      return send(res, 200, { ok: true });
    }
    if (p === '/settings' && m === 'PUT') {
      try { store.setSettings(await readBody(req)); } catch (e) { throw new HttpError(400, e.message); }
      return send(res, 200, state());
    }
    if ((mm = /^\/instruments\/([^/]+)$/.exec(p)) && m === 'PUT') {
      const b = await readBody(req);
      try {
        store.setInstrument(decodeURIComponent(mm[1]), { multiplier: Number(b.multiplier), fee: Number(b.fee), name: b.name });
      } catch (e) { throw new HttpError(400, e.message); }
      return send(res, 200, state());
    }
    if (p === '/data' && m === 'DELETE') {
      const { confirm } = await readBody(req, 4096);
      if (confirm !== 'BORRAR') throw new HttpError(400, 'Falta la confirmación.');
      for (const s of store.deleteAllData()) fs.rmSync(path.join(uploadsDir, path.basename(s)), { force: true });
      return send(res, 200, state());
    }
    if (p === '/economic' && m === 'GET') {
      const q = url.searchParams;
      const out = { source: 'Forex Factory (feed público)', coverage: 'week', events: [],
        note: 'Feed público gratuito: solo la semana en curso y sin valores "actual". Para ver historial usa la página publicada en Claude con tu cuenta de Tradezella.' };
      try {
        if (!feedCache || Date.now() - feedCache.at > 30 * 60_000) {
          const r = await doFetch(PUBLIC_FEED, { headers: { Accept: 'application/json' } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          feedCache = { at: Date.now(), json: await r.json() };
        }
        out.events = filterEvents(mapPublicFeed(feedCache.json, store.settings().tz), {
          from: q.get('from') || undefined, to: q.get('to') || undefined, impact: q.get('impact') || undefined, countries: q.get('countries') || undefined,
        });
      } catch (e) { out.error = `No se pudo cargar el calendario económico (${e.message}).`; }
      return send(res, 200, out);
    }
    if (p === '/sync' && m === 'POST') {
      try { const r = await sync.run(); return send(res, 200, { ...r, sync: sync.status }); }
      catch (e) { throw new HttpError(502, e.message); }
    }
    throw new HttpError(404, 'Ruta no encontrada.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido.');
      if (url.pathname.startsWith('/uploads/')) {
        if (!authed(req)) throw new HttpError(401, 'Inicia sesión.');
        return serveFile(res, uploadsDir, decodeURIComponent(url.pathname.slice('/uploads/'.length)));
      }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
      return serveFile(res, publicDir, rel);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Error interno del servidor.' : e.message });
      else res.end();
    }
  });

  return { server, store, sync };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PORT) || 3000;
  const { server, sync } = createApp({
    dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
    password: process.env.APP_PASSWORD || '',
    tradovate: tradovateConfig(process.env),
  });
  server.listen(port, () => {
    console.log(`Diario de trading en http://localhost:${port}`);
    if (!process.env.APP_PASSWORD) console.log('Aviso: sin APP_PASSWORD la app no pide contraseña. Defínela antes de publicarla.');
    console.log(sync.status.configured ? `Sincronización con Tradovate (${sync.status.env}) activa.` : 'Sincronización con Tradovate sin configurar (ver .env.example).');
    sync.start();
  });
}
