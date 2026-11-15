import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrades } from '../server/engine.js';
import { parseTradovateCsv, parseCsv, parseNumber } from '../server/csv.js';
import { parseTimestamp, wallToUtc, dayKey } from '../server/time.js';
import { rootOf } from '../server/instruments.js';
import { summarize, groupStats, rMultiple, weekday } from '../public/lib/stats.js';

const TZ = 'America/New_York';
const inst = new Map([['ES', { multiplier: 50, fee: 2 }], ['MNQ', { multiplier: 2, fee: 0.5 }]]);
const fill = (id, side, qty, price, ts, extra = {}) =>
  ({ id, account: 'A', contract: 'ESZ6', side, qty, price, ts, fee: null, source: 'csv', ...extra });

test('rootOf separa la raíz del vencimiento', () => {
  assert.equal(rootOf('ESZ6'), 'ES');
  assert.equal(rootOf('MNQZ6'), 'MNQ');
  assert.equal(rootOf('MESH27'), 'MES');
  assert.equal(rootOf('6EZ6'), '6E');
  assert.equal(rootOf('M2KU6'), 'M2K');
  assert.equal(rootOf('AAPL'), 'AAPL');
});

test('zona horaria: hora local a UTC con y sin horario de verano', () => {
  assert.equal(wallToUtc(2026, 11, 13, 9, 30, 0, TZ).toISOString(), '2026-11-13T14:30:00.000Z');
  assert.equal(wallToUtc(2026, 7, 1, 9, 30, 0, TZ).toISOString(), '2026-07-01T13:30:00.000Z');
  assert.equal(parseTimestamp('11/13/2026 09:30:05', TZ).toISOString(), '2026-11-13T14:30:05.000Z');
  assert.equal(parseTimestamp('11/13/2026 1:05:00 PM', TZ).toISOString(), '2026-11-13T18:05:00.000Z');
  assert.equal(parseTimestamp('2026-11-13T09:30', TZ).toISOString(), '2026-11-13T14:30:00.000Z');
  assert.equal(parseTimestamp('2026-11-13T14:30:00.000Z', TZ).toISOString(), '2026-11-13T14:30:00.000Z');
  assert.equal(parseTimestamp('basura', TZ), null);
  assert.equal(dayKey(new Date('2026-11-14T02:00:00Z'), TZ), '2026-11-13');
});

test('operación larga simple: P&L bruto, comisiones y neto', () => {
  const [t] = buildTrades([
    fill('1', 'B', 2, 5000, '2026-11-13T14:30:00.000Z'),
    fill('2', 'S', 2, 5010, '2026-11-13T14:45:00.000Z'),
  ], inst, TZ);
  assert.equal(t.side, 'long');
  assert.equal(t.qty, 2);
  assert.equal(t.gross, 1000);      // 10 puntos * 2 contratos * 50
  assert.equal(t.fees, 8);          // 2 por lado por contrato
  assert.equal(t.net, 992);
  assert.equal(t.status, 'closed');
  assert.equal(t.durationS, 900);
  assert.equal(t.day, '2026-11-13');
  assert.equal(t.hour, 9);
});

test('corta con entradas y salidas parciales', () => {
  const [t] = buildTrades([
    fill('1', 'S', 1, 5010, '2026-11-13T14:30:00.000Z'),
    fill('2', 'S', 1, 5020, '2026-11-13T14:31:00.000Z'),
    fill('3', 'B', 1, 5005, '2026-11-13T14:40:00.000Z'),
    fill('4', 'B', 1, 5000, '2026-11-13T14:50:00.000Z'),
  ], inst, TZ);
  assert.equal(t.side, 'short');
  assert.equal(t.entryPrice, 5015);
  assert.equal(t.exitPrice, 5002.5);
  assert.equal(t.gross, 1250);      // 12.5 puntos * 2 * 50
  assert.equal(t.legs.length, 4);
});

test('una ejecución que invierte la posición se divide en dos operaciones', () => {
  const trades = buildTrades([
    fill('1', 'B', 1, 5000, '2026-11-13T14:30:00.000Z'),
    fill('2', 'S', 3, 5004, '2026-11-13T14:35:00.000Z'),
    fill('3', 'B', 2, 5000, '2026-11-13T14:40:00.000Z'),
  ], inst, TZ);
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map((t) => [t.id, t.side, t.qty, t.gross]), [['1', 'long', 1, 200], ['2#2', 'short', 2, 400]]);
  assert.equal(trades[0].fees + trades[1].fees, 12); // 6 contratos-lado * 2
});

test('posición sin cerrar queda abierta; cuentas y contratos no se mezclan', () => {
  const trades = buildTrades([
    fill('1', 'B', 1, 5000, '2026-11-13T14:30:00.000Z'),
    fill('2', 'S', 1, 5001, '2026-11-13T14:31:00.000Z', { account: 'B' }),
    fill('3', 'B', 1, 20000, '2026-11-13T14:32:00.000Z', { contract: 'MNQZ6', fee: 0.74 }),
    fill('4', 'S', 1, 20010, '2026-11-13T14:33:00.000Z', { contract: 'MNQZ6', fee: 0.74 }),
  ], inst, TZ);
  assert.equal(trades.length, 3);
  assert.equal(trades.filter((t) => t.status === 'open').length, 2);
  const mnq = trades.find((t) => t.root === 'MNQ');
  assert.equal(mnq.gross, 20);
  assert.equal(mnq.fees, 1.48);     // comisión real de la ejecución, no la del ajuste
});

test('CSV: comillas, importes con formato', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","z ""q"""\n'), [['a', 'b'], ['x, y', 'z "q"']]);
  assert.equal(parseNumber('$1,250.50'), 1250.5);
  assert.equal(parseNumber('$(50.00)'), -50);
  assert.equal(parseNumber('-$12.5'), -12.5);
});

test('importa el reporte Performance de Tradovate y deduce el valor por punto', () => {
  const csv = [
    'symbol,_priceFormat,_priceFormatType,_tickSize,buyFillId,sellFillId,qty,buyPrice,sellPrice,pnl,boughtTimestamp,soldTimestamp,duration',
    'MNQZ6,-2,0,0.25,101,102,1,20000.00,20010.00,$20.00,11/13/2026 09:30:00,11/13/2026 09:35:00,5min',
    'MNQZ6,-2,0,0.25,101,103,1,20000.00,19995.00,$(10.00),11/13/2026 09:30:00,11/13/2026 09:40:00,10min',
    'XYZZ6,-2,0,0.25,201,200,1,105.00,100.00,$(35.00),11/13/2026 10:05:00,11/13/2026 10:00:00,5min',
  ].join('\n');
  const r = parseTradovateCsv(csv, { tz: TZ, account: 'Real' });
  assert.equal(r.format, 'Performance');
  assert.equal(r.fills.length, 5);
  const f101 = r.fills.find((f) => f.id === 'tv-101');
  assert.equal(f101.qty, 2);          // la misma ejecución aparece en dos filas
  assert.equal(f101.ts, '2026-11-13T14:30:00.000Z');
  assert.deepEqual(r.derivedMultipliers, { MNQ: 2, XYZ: 7 });

  const trades = buildTrades(r.fills, new Map([...inst, ['XYZ', { multiplier: 7, fee: 0 }]]), TZ);
  assert.equal(trades.length, 2);
  const mnq = trades.find((t) => t.root === 'MNQ');
  assert.equal(mnq.gross, 10);
  assert.equal(mnq.qty, 2);
  const xyz = trades.find((t) => t.root === 'XYZ');
  assert.equal(xyz.side, 'short');
  assert.equal(xyz.gross, -35);
});

test('importa el reporte Fills y rechaza formatos desconocidos', () => {
  const csv = 'Fill ID,Order ID,Contract,B/S,Quantity,Price,Timestamp,Account,commission\n'
    + '11,1,ESZ6,Buy,1,5000.25,11/13/2026 09:30:00,ACC1,1.29\n'
    + '12,2,ESZ6,Sell,1,5002.25,11/13/2026 09:31:00,ACC1,1.29\n';
  const r = parseTradovateCsv(csv, { tz: TZ, account: 'x' });
  assert.equal(r.format, 'Fills');
  assert.deepEqual(r.fills.map((f) => [f.id, f.side, f.account, f.fee]), [['tv-11', 'B', 'ACC1', 1.29], ['tv-12', 'S', 'ACC1', 1.29]]);
  assert.throws(() => parseTradovateCsv('a,b\n1,2\n', { tz: TZ, account: 'x' }), /No reconozco/);
});

test('métricas: tasa de acierto, factor de beneficio, drawdown y rachas', () => {
  const mk = (net, day, i, extra = {}) => ({
    status: 'closed', net, gross: net + 1, fees: 1, qty: 1, day, exitTs: `${day}T15:0${i}:00Z`, durationS: 60,
    entryPrice: 100, mult: 1, stop: null, ...extra,
  });
  const s = summarize([
    mk(100, '2026-11-09', 0), mk(-50, '2026-11-09', 1), mk(-100, '2026-11-10', 0),
    mk(200, '2026-11-11', 0), mk(0, '2026-11-11', 1), { status: 'open', net: 999 },
  ]);
  assert.equal(s.count, 5);
  assert.equal(s.net, 150);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.profitFactor, 2);
  assert.equal(s.avgWin, 150);
  assert.equal(s.avgLoss, -75);
  assert.equal(s.expectancy, 30);
  assert.equal(s.maxDrawdown, 150);  // de +100 a -50
  assert.equal(s.maxLossStreak, 2);
  assert.equal(s.breakeven, 1);
  assert.equal(s.tradingDays, 3);
  assert.equal(s.dayWinRate, 2 / 3);
  assert.equal(s.bestDay.day, '2026-11-11');
  assert.deepEqual(s.days.map((d) => d.cum), [50, -50, 150]);
  assert.equal(rMultiple(mk(50, '2026-11-09', 0, { stop: 75 })), 2);
  assert.equal(weekday('2026-11-13'), 5);
  const g = groupStats([mk(10, '2026-11-09', 0, { tags: ['a', 'b'] }), mk(-5, '2026-11-09', 1, { tags: ['a'] })], (t) => t.tags);
  assert.deepEqual(g.map((x) => [x.key, x.net, x.count]), [['a', 5, 2], ['b', 10, 1]]);
});
