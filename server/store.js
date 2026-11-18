import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_INSTRUMENTS, rootOf } from './instruments.js';
import { buildTrades } from './engine.js';
import { isValidTz } from './time.js';
import { normalizeRules } from '../public/lib/insights.js';
import { normalizePlaybooks } from '../public/lib/playbooks.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, contract TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('B','S')), qty REAL NOT NULL, price REAL NOT NULL,
  ts TEXT NOT NULL, fee REAL, source TEXT NOT NULL, batch TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS trade_meta (
  trade_id TEXT PRIMARY KEY, notes TEXT NOT NULL DEFAULT '', strategy TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', mistakes TEXT NOT NULL DEFAULT '[]', stop REAL,
  shots TEXT NOT NULL DEFAULT '[]', playbook TEXT NOT NULL DEFAULT '', followed TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS instruments (
  root TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', multiplier REAL NOT NULL, fee REAL NOT NULL DEFAULT 0
);
`;

const DEFAULT_SETTINGS = { tz: 'America/New_York' };

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // bases creadas antes de los playbooks: añade las columnas que falten
    const cols = new Set(this.db.prepare('PRAGMA table_info(trade_meta)').all().map((c) => c.name));
    if (!new Set(this.db.prepare('PRAGMA table_info(fills)').all().map((c) => c.name)).has('batch')) this.db.exec("ALTER TABLE fills ADD COLUMN batch TEXT NOT NULL DEFAULT ''");
    if (!cols.has('playbook')) this.db.exec("ALTER TABLE trade_meta ADD COLUMN playbook TEXT NOT NULL DEFAULT ''");
    if (!cols.has('followed')) this.db.exec("ALTER TABLE trade_meta ADD COLUMN followed TEXT NOT NULL DEFAULT '[]'");
    const ins = this.db.prepare('INSERT OR IGNORE INTO instruments (root, name, multiplier, fee) VALUES (?,?,?,0)');
    for (const [root, name, mult] of DEFAULT_INSTRUMENTS) ins.run(root, name, mult);
    this.cache = null;
  }

  // --- ajustes ---
  settings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
    delete out.imports;
    out.rules = normalizeRules(out.rules);
    out.playbooks = normalizePlaybooks(out.playbooks);
    return out;
  }
  setSettings(patch) {
    const put = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (patch.tz !== undefined) {
      if (!isValidTz(patch.tz)) throw new Error('Zona horaria no válida.');
      put.run('tz', JSON.stringify(patch.tz));
    }
    if (patch.rules !== undefined) put.run('rules', JSON.stringify(normalizeRules(patch.rules)));
    if (patch.playbooks !== undefined) put.run('playbooks', JSON.stringify(normalizePlaybooks(patch.playbooks)));
    this.cache = null;
  }

  // --- instrumentos ---
  instruments() {
    return this.db.prepare('SELECT root, name, multiplier, fee FROM instruments ORDER BY root').all();
  }
  setInstrument(root, { multiplier, fee, name }) {
    root = String(root).trim().toUpperCase();
    if (!root) throw new Error('Falta el símbolo.');
    if (!(multiplier > 0)) throw new Error('El valor por punto debe ser mayor que cero.');
    if (!(fee >= 0)) throw new Error('La comisión no puede ser negativa.');
    this.db.prepare(`INSERT INTO instruments (root, name, multiplier, fee) VALUES (?,?,?,?)
      ON CONFLICT(root) DO UPDATE SET multiplier = excluded.multiplier, fee = excluded.fee`)
      .run(root, name || '', multiplier, fee);
    this.cache = null;
  }
  /** Registra instrumentos nuevos detectados en una importación, sin pisar los existentes. */
  addMissingInstruments(multipliers) {
    const known = new Set(this.instruments().map((i) => i.root));
    const added = [];
    for (const [root, mult] of Object.entries(multipliers)) {
      if (known.has(root) || !(mult > 0)) continue;
      this.db.prepare('INSERT INTO instruments (root, name, multiplier, fee) VALUES (?,?,?,0)').run(root, '', mult);
      added.push(root);
    }
    if (added.length) this.cache = null;
    return added;
  }

  // --- ejecuciones ---
  /**
   * Inserta ejecuciones. Las repetidas (mismo id) se ignoran, salvo con `authoritative`
   * (datos de la API), que actualiza cuenta y comisión real.
   */
  addFills(fills, { authoritative = false, batch = '' } = {}) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO fills (id, account, contract, side, qty, price, ts, fee, source, batch)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const update = this.db.prepare('UPDATE fills SET account = ?, fee = COALESCE(?, fee), source = ? WHERE id = ?');
    let added = 0, duplicates = 0;
    this.db.exec('BEGIN');
    try {
      for (const f of fills) {
        const r = insert.run(f.id, f.account, f.contract, f.side, f.qty, f.price, f.ts, f.fee ?? null, f.source, batch);
        if (r.changes) added++;
        else { duplicates++; if (authoritative) update.run(f.account, f.fee ?? null, f.source, f.id); }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.cache = null;
    return { added, duplicates };
  }
  // --- archivos importados ---
  /** Registra un archivo importado y devuelve su id. */
  recordImport(name, added) {
    const id = `imp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const list = this._importLog();
    list.push({ id, name: String(name || 'archivo.csv').slice(0, 200), at: new Date().toISOString(), added });
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('imports', JSON.stringify(list.slice(-200)));
    return id;
  }
  _importLog() {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'imports'").get();
    return r ? JSON.parse(r.value) : [];
  }
  /** Archivos importados con las ejecuciones que conservan, del más reciente al más antiguo. */
  imports() {
    const counts = new Map(this.db.prepare('SELECT batch, COUNT(*) AS n FROM fills GROUP BY batch').all().map((r) => [r.batch, r.n]));
    const out = this._importLog().map((i) => ({ ...i, fills: counts.get(i.id) || 0 })).filter((i) => i.fills > 0).reverse();
    const legacy = this.db.prepare("SELECT COUNT(*) AS n FROM fills WHERE batch = '' AND source = 'csv'").get().n;
    if (legacy) out.push({ id: 'legacy', name: 'Importaciones anteriores', at: null, added: legacy, fills: legacy });
    return out;
  }
  /** Borra todas las ejecuciones de un archivo importado y las operaciones que dejan de existir. */
  deleteImport(id) {
    const before = new Set(this.trades().map((t) => t.id));
    this.db.exec('BEGIN');
    let fills;
    try {
      fills = id === 'legacy'
        ? this.db.prepare("DELETE FROM fills WHERE batch = '' AND source = 'csv'").run().changes
        : this.db.prepare('DELETE FROM fills WHERE batch = ?').run(String(id)).changes;
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.cache = null;
    const after = new Set(this.trades().map((t) => t.id));
    const gone = [...before].filter((x) => !after.has(x));
    const shots = [];
    const sel = this.db.prepare('SELECT shots FROM trade_meta WHERE trade_id = ?'), del = this.db.prepare('DELETE FROM trade_meta WHERE trade_id = ?');
    for (const tid of gone) { const r = sel.get(tid); if (r) shots.push(...JSON.parse(r.shots)); del.run(tid); }
    const log = this._importLog().filter((i) => i.id !== id);
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('imports', JSON.stringify(log));
    this.cache = null;
    return { fills, trades: gone.length, shots };
  }

  /** Borra varias operaciones a la vez con sus ejecuciones y metadatos. Devuelve las capturas a eliminar. */
  deleteTrades(ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String));
    const shots = [];
    let deleted = 0;
    const delFill = this.db.prepare('DELETE FROM fills WHERE id = ?'), delMeta = this.db.prepare('DELETE FROM trade_meta WHERE trade_id = ?');
    this.db.exec('BEGIN');
    try {
      for (const t of this.trades()) {
        if (!want.has(t.id)) continue;
        for (const fid of new Set(t.legs.map((l) => l.id))) delFill.run(fid);
        delMeta.run(t.id); shots.push(...t.shots); deleted++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.cache = null;
    return { deleted, shots };
  }

  /** Cambia la etiqueta de archivo de las ejecuciones recién insertadas. */
  relabelBatch(from, to) {
    this.db.prepare('UPDATE fills SET batch = ? WHERE batch = ?').run(to, from);
    this.cache = null;
  }
  fillCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM fills').get().n; }

  // --- operaciones (derivadas de las ejecuciones) ---
  trades() {
    if (this.cache) return this.cache;
    const fills = this.db.prepare('SELECT * FROM fills').all();
    const inst = new Map(this.instruments().map((i) => [i.root, i]));
    const built = buildTrades(fills, inst, this.settings().tz);
    const meta = new Map(this.db.prepare('SELECT * FROM trade_meta').all().map((m) => [m.trade_id, m]));
    this.cache = built.map((t) => {
      const m = meta.get(t.id);
      return {
        ...t,
        notes: m?.notes || '', strategy: m?.strategy || '',
        tags: m ? JSON.parse(m.tags) : [], mistakes: m ? JSON.parse(m.mistakes) : [],
        stop: m?.stop ?? null, shots: m ? JSON.parse(m.shots) : [],
        playbook: m?.playbook || '', followed: m ? JSON.parse(m.followed) : [],
      };
    });
    return this.cache;
  }
  trade(id) { return this.trades().find((t) => t.id === id) || null; }

  setMeta(id, patch) {
    const t = this.trade(id);
    if (!t) throw new Error('Operación no encontrada.');
    const list = (v, max = 30) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
    const next = {
      notes: patch.notes !== undefined ? String(patch.notes).slice(0, 20000) : t.notes,
      strategy: patch.strategy !== undefined ? String(patch.strategy).trim().slice(0, 80) : t.strategy,
      tags: patch.tags !== undefined ? list(patch.tags) : t.tags,
      mistakes: patch.mistakes !== undefined ? list(patch.mistakes) : t.mistakes,
      stop: patch.stop !== undefined ? (patch.stop === null || patch.stop === '' || !isFinite(+patch.stop) ? null : +patch.stop) : t.stop,
      shots: patch.shots !== undefined ? patch.shots : t.shots,
      playbook: patch.playbook !== undefined ? String(patch.playbook).trim().slice(0, 40) : t.playbook,
      followed: patch.followed !== undefined ? list(patch.followed, 100) : t.followed,
    };
    this.db.prepare(`INSERT INTO trade_meta (trade_id, notes, strategy, tags, mistakes, stop, shots, playbook, followed) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(trade_id) DO UPDATE SET notes = excluded.notes, strategy = excluded.strategy, tags = excluded.tags,
        mistakes = excluded.mistakes, stop = excluded.stop, shots = excluded.shots, playbook = excluded.playbook, followed = excluded.followed`)
      .run(id, next.notes, next.strategy, JSON.stringify(next.tags), JSON.stringify(next.mistakes), next.stop, JSON.stringify(next.shots),
        next.playbook, JSON.stringify(next.followed));
    this.cache = null;
    return this.trade(id);
  }

  deleteTrade(id) {
    const t = this.trade(id);
    if (!t) throw new Error('Operación no encontrada.');
    const del = this.db.prepare('DELETE FROM fills WHERE id = ?');
    for (const fid of new Set(t.legs.map((l) => l.id))) del.run(fid);
    this.db.prepare('DELETE FROM trade_meta WHERE trade_id = ?').run(id);
    this.cache = null;
    return t;
  }

  /** Borra operaciones, notas del día, playbooks y metadatos. Conserva zona horaria, reglas y los instrumentos por defecto. Devuelve los nombres de las capturas. */
  deleteAllData() {
    const shots = this.db.prepare('SELECT shots FROM trade_meta').all().flatMap((r) => JSON.parse(r.shots));
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM fills; DELETE FROM trade_meta; DELETE FROM days;');
      this.db.prepare("DELETE FROM settings WHERE key IN ('playbooks', 'imports')").run();
      const keep = DEFAULT_INSTRUMENTS.map((i) => i[0]);
      this.db.prepare(`DELETE FROM instruments WHERE root NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.cache = null;
    return shots;
  }

  // --- diario ---
  days() {
    const out = {};
    for (const r of this.db.prepare("SELECT day, notes FROM days WHERE notes <> ''").all()) out[r.day] = r.notes;
    return out;
  }
  setDay(day, notes) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Fecha no válida.');
    this.db.prepare('INSERT INTO days (day, notes) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET notes = excluded.notes')
      .run(day, String(notes ?? '').slice(0, 20000));
  }
}

export { rootOf };
