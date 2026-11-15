import { parseTimestamp } from './time.js';
import { rootOf } from './instruments.js';

/** Parser CSV con soporte de comillas, comas internas y saltos de línea. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/** "$1,250.50" -> 1250.5 ; "$(50.00)" o "-$50" -> -50 */
export function parseNumber(v) {
  let s = String(v ?? '').trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s.replace(/\$/g, '')) || s.includes('-');
  s = s.replace(/[$,()\s-]/g, '');
  const n = Number(s);
  return neg ? -n : n;
}

function table(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('El archivo está vacío o no tiene filas de datos.');
  const headers = rows[0].map(norm);
  const col = (...names) => {
    for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  return { rows: rows.slice(1), headers, col };
}

/**
 * Convierte un CSV exportado de Tradovate en ejecuciones (fills).
 * Formatos admitidos:
 *  - "Performance": una fila por par compra/venta (buyFillId, sellFillId, qty, buyPrice, sellPrice…)
 *  - "Fills": una fila por ejecución (Fill ID, B/S, Contract, Quantity, Price, Timestamp…)
 * Devuelve { format, fills, warnings, derivedMultipliers }.
 */
export function parseTradovateCsv(text, { tz, account }) {
  const t = table(text);
  const warnings = [];
  const isPerformance = t.col('buyfillid') >= 0 && t.col('sellfillid') >= 0;
  if (isPerformance) return parsePerformance(t, { tz, account, warnings });
  const isFills = t.col('bs', 'buysell', 'side', 'action') >= 0 && t.col('price', 'fillprice', 'avgprice') >= 0
    && t.col('fillid', 'id') >= 0;
  if (isFills) return parseFills(t, { tz, account, warnings });
  throw new Error('No reconozco el formato. Exporta el reporte "Performance" o "Fills" de Tradovate en CSV.');
}

function parsePerformance(t, { tz, account, warnings }) {
  const c = {
    symbol: t.col('symbol', 'contract'), qty: t.col('qty', 'quantity'),
    buyPrice: t.col('buyprice'), sellPrice: t.col('sellprice'), pnl: t.col('pnl'),
    buyId: t.col('buyfillid'), sellId: t.col('sellfillid'),
    buyTs: t.col('boughttimestamp', 'buytimestamp'), sellTs: t.col('soldtimestamp', 'selltimestamp'),
    account: t.col('account', 'accountname'),
  };
  for (const k of ['symbol', 'qty', 'buyPrice', 'sellPrice', 'buyTs', 'sellTs']) {
    if (c[k] < 0) throw new Error(`Falta la columna "${k}" en el reporte Performance.`);
  }
  const byId = new Map();
  const mult = new Map(); // root -> multiplicadores observados
  let skipped = 0;
  t.rows.forEach((r) => {
    const contract = String(r[c.symbol] || '').trim().toUpperCase();
    const qty = parseNumber(r[c.qty]);
    const bp = parseNumber(r[c.buyPrice]), sp = parseNumber(r[c.sellPrice]);
    const bts = parseTimestamp(r[c.buyTs], tz), sts = parseTimestamp(r[c.sellTs], tz);
    if (!contract || !(qty > 0) || !isFinite(bp) || !isFinite(sp) || !bts || !sts) { skipped++; return; }
    const acc = (c.account >= 0 && String(r[c.account]).trim()) || account;
    const add = (rawId, side, price, ts) => {
      const id = `tv-${String(rawId).trim()}`;
      const f = byId.get(id);
      if (f) f.qty += qty;
      else byId.set(id, { id, account: acc, contract, side, qty, price, ts: ts.toISOString(), fee: null, source: 'csv' });
    };
    add(r[c.buyId], 'B', bp, bts);
    add(r[c.sellId], 'S', sp, sts);
    if (c.pnl >= 0) {
      const pnl = parseNumber(r[c.pnl]);
      const move = Math.abs(sp - bp) * qty;
      if (isFinite(pnl) && Math.abs(pnl) > 0 && move > 0) {
        const root = rootOf(contract);
        if (!mult.has(root)) mult.set(root, []);
        mult.get(root).push(Math.abs(pnl) / move);
      }
    }
  });
  if (skipped) warnings.push(`${skipped} fila(s) incompleta(s) se omitieron.`);
  const derivedMultipliers = {};
  for (const [root, list] of mult) {
    list.sort((a, b) => a - b);
    derivedMultipliers[root] = +list[Math.floor(list.length / 2)].toPrecision(6);
  }
  return { format: 'Performance', fills: [...byId.values()], warnings, derivedMultipliers };
}

function parseFills(t, { tz, account, warnings }) {
  const c = {
    id: t.col('fillid', 'id'), side: t.col('bs', 'buysell', 'side', 'action'),
    contract: t.col('contract', 'symbol'), qty: t.col('quantity', 'qty', 'filledqty'),
    price: t.col('price', 'fillprice', 'avgprice'), ts: t.col('timestamp', 'filltime', 'time', 'date'),
    account: t.col('account', 'accountname'), fee: t.col('commission', 'fees', 'fee'),
    active: t.col('active'),
  };
  for (const k of ['contract', 'qty', 'ts']) {
    if (c[k] < 0) throw new Error(`Falta la columna "${k}" en el reporte Fills.`);
  }
  const fills = [];
  let skipped = 0;
  for (const r of t.rows) {
    if (c.active >= 0 && /^(false|0|no)$/i.test(String(r[c.active]).trim())) continue;
    const sideRaw = String(r[c.side] || '').trim().toLowerCase();
    const side = sideRaw.startsWith('b') ? 'B' : sideRaw.startsWith('s') ? 'S' : null;
    const qty = Math.abs(parseNumber(r[c.qty]));
    const price = parseNumber(r[c.price]);
    const ts = parseTimestamp(r[c.ts], tz);
    const rawId = String(r[c.id] || '').trim();
    const contract = String(r[c.contract] || '').trim().toUpperCase();
    if (!side || !(qty > 0) || !isFinite(price) || !ts || !rawId || !contract) { skipped++; continue; }
    const fee = c.fee >= 0 ? Math.abs(parseNumber(r[c.fee])) : NaN;
    fills.push({
      id: `tv-${rawId}`, account: (c.account >= 0 && String(r[c.account]).trim()) || account,
      contract, side, qty, price, ts: ts.toISOString(), fee: isFinite(fee) ? fee : null, source: 'csv',
    });
  }
  if (skipped) warnings.push(`${skipped} fila(s) incompleta(s) se omitieron.`);
  return { format: 'Fills', fills, warnings, derivedMultipliers: {} };
}
