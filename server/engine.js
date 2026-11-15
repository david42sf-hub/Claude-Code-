import { rootOf } from './instruments.js';
import { dayKey, tzParts } from './time.js';

const EPS = 1e-9;

/**
 * Agrupa ejecuciones en operaciones completas (de posición plana a posición plana),
 * por cuenta y contrato. Si una ejecución invierte la posición, se divide en dos.
 *
 * fills: [{id, account, contract, side:'B'|'S', qty, price, ts, fee|null, source}]
 * instruments: Map(root -> {multiplier, fee})
 */
export function buildTrades(fills, instruments, tz) {
  const sorted = [...fills].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  const books = new Map();
  const trades = [];

  for (const f of sorted) {
    const key = `${f.account}\u0000${f.contract}`;
    let book = books.get(key);
    if (!book) { book = { pos: 0, cur: null }; books.set(key, book); }
    const root = rootOf(f.contract);
    const inst = instruments.get(root) || { multiplier: 1, fee: 0, unknown: true };
    const dir = f.side === 'B' ? 1 : -1;
    const feePerUnit = f.fee != null ? f.fee / f.qty : inst.fee;
    let remaining = f.qty;
    let part = 0;

    while (remaining > EPS) {
      if (Math.abs(book.pos) < EPS) {
        book.pos = 0;
        book.cur = {
          id: part === 0 ? f.id : `${f.id}#${part + 1}`,
          account: f.account, contract: f.contract, root,
          side: dir === 1 ? 'long' : 'short',
          mult: inst.multiplier, unknownInstrument: !!inst.unknown,
          manual: f.source === 'manual',
          legs: [], entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0, fees: 0,
        };
        trades.push(book.cur);
      }
      const t = book.cur;
      const opening = Math.sign(book.pos) === dir || book.pos === 0;
      const q = opening ? remaining : Math.min(remaining, Math.abs(book.pos));
      t.legs.push({ id: f.id, side: f.side, qty: q, price: f.price, ts: f.ts, role: opening ? 'in' : 'out' });
      t.fees += feePerUnit * q;
      if (opening) { t.entryQty += q; t.entryNotional += q * f.price; }
      else { t.exitQty += q; t.exitNotional += q * f.price; }
      book.pos += dir * q;
      remaining -= q;
      part++;
      if (Math.abs(book.pos) < EPS) { book.pos = 0; book.cur = null; }
    }
  }

  return trades.map((t) => finalize(t, tz));
}

function finalize(t, tz) {
  const sign = t.side === 'long' ? 1 : -1;
  const entryPrice = t.entryNotional / t.entryQty;
  const exitPrice = t.exitQty > 0 ? t.exitNotional / t.exitQty : null;
  const closed = Math.abs(t.entryQty - t.exitQty) < EPS;
  const gross = exitPrice == null ? 0 : sign * (exitPrice - entryPrice) * t.exitQty * t.mult;
  const entryTs = t.legs[0].ts;
  const exitTs = closed ? t.legs[t.legs.length - 1].ts : null;
  const ref = new Date(exitTs || entryTs);
  const round = (n) => Math.round(n * 100) / 100;
  return {
    id: t.id, account: t.account, contract: t.contract, root: t.root, side: t.side,
    qty: t.entryQty, entryPrice, exitPrice, entryTs, exitTs,
    day: dayKey(ref, tz), hour: tzParts(new Date(entryTs), tz).h,
    durationS: exitTs ? Math.round((new Date(exitTs) - new Date(entryTs)) / 1000) : null,
    gross: round(gross), fees: round(t.fees), net: round(gross - t.fees),
    status: closed ? 'closed' : 'open', mult: t.mult,
    unknownInstrument: t.unknownInstrument, manual: t.manual, legs: t.legs,
  };
}
