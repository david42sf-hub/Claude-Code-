import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_INSTRUMENTS, rootOf } from './instruments.js';
import { buildTrades } from './engine.js';
import { isValidTz } from './time.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, contract TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('B','S')), qty REAL NOT NULL, price REAL NOT NULL,
  ts TEXT NOT NULL, fee REAL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trade_meta (
  trade_id TEXT PRIMARY KEY, notes TEXT NOT NULL DEFAULT '', strategy TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', mistakes TEXT NOT NULL DEFAULT '[]', stop REAL,
  shots TEXT NOT NULL DEFAULT '[]'
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
    const ins = this.db.prepare('INSERT OR IGNORE INTO instruments (root, name, multiplier, fee) VALUES (?,?,?,0)');
    for (const [root, name, mult] of DEFAULT_INSTRUMENTS) ins.run(root, name, mult);
    this.cache = null;
  }

  // --- ajustes ---
  settings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
    return out;
  }
  setSettings(patch) {
    if (patch.tz !== undefined) {
      if (!isValidTz(patch.tz)) throw new Error('Zona horaria no válida.');
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('tz', JSON.stringify(patch.tz));
    }
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
  addFills(fills, { authoritative = false } = {}) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO fills (id, account, contract, side, qty, price, ts, fee, source)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const update = this.db.prepare('UPDATE fills SET account = ?, fee = COALESCE(?, fee), source = ? WHERE id = ?');
    let added = 0, duplicates = 0;
    this.db.exec('BEGIN');
    try {
      for (const f of fills) {
        const r = insert.run(f.id, f.account, f.contract, f.side, f.qty, f.price, f.ts, f.fee ?? null, f.source);
        if (r.changes) added++;
        else { duplicates++; if (authoritative) update.run(f.account, f.fee ?? null, f.source, f.id); }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.cache = null;
    return { added, duplicates };
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
      };
    });
    return this.cache;
  }
  trade(id) { return this.trades().find((t) => t.id === id) || null; }

  setMeta(id, patch) {
    const t = this.trade(id);
    if (!t) throw new Error('Operación no encontrada.');
    const list = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
    const next = {
      notes: patch.notes !== undefined ? String(patch.notes).slice(0, 20000) : t.notes,
      strategy: patch.strategy !== undefined ? String(patch.strategy).trim().slice(0, 80) : t.strategy,
      tags: patch.tags !== undefined ? list(patch.tags) : t.tags,
      mistakes: patch.mistakes !== undefined ? list(patch.mistakes) : t.mistakes,
      stop: patch.stop !== undefined ? (patch.stop === null || patch.stop === '' || !isFinite(+patch.stop) ? null : +patch.stop) : t.stop,
      shots: patch.shots !== undefined ? patch.shots : t.shots,
    };
    this.db.prepare(`INSERT INTO trade_meta (trade_id, notes, strategy, tags, mistakes, stop, shots) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(trade_id) DO UPDATE SET notes = excluded.notes, strategy = excluded.strategy, tags = excluded.tags,
        mistakes = excluded.mistakes, stop = excluded.stop, shots = excluded.shots`)
      .run(id, next.notes, next.strategy, JSON.stringify(next.tags), JSON.stringify(next.mistakes), next.stop, JSON.stringify(next.shots));
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
