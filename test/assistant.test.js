import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandles, marketSnapshot } from '../artifact/assistant.js';

// Velas de 30 minutos en ET entre dos instantes, con precio determinista.
const csvFor = (fromLocal, toLocal, base) => {
  const rows = [];
  let [d, h, m] = [fromLocal.slice(0, 10), +fromLocal.slice(11, 13), +fromLocal.slice(14, 16)];
  const end = Date.parse(`${toLocal}:00Z`);
  let i = 0;
  while (Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) < end) {
    const p = base + i * 2;
    rows.push(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00,${p},${p + 10},${p - 5},${p + 4},100`);
    m += 30; if (m === 60) { m = 0; h++; }
    if (h === 24) { h = 0; const nd = new Date(`${d}T00:00:00Z`); nd.setUTCDate(nd.getUTCDate() + 1); d = nd.toISOString().slice(0, 10); }
    i++;
  }
  return `# METADATA\n# symbol: NQ\n# time_zone: America/New_York\n\ntime,open,high,low,close,volume\n${rows.join('\n')}\n`;
};

test('parseCandles lee la cabecera de metadatos y las velas en la zona indicada', () => {
  const { tz, candles } = parseCandles(csvFor('2026-11-16T09:30', '2026-11-16T11:00', 27000));
  assert.equal(tz, 'America/New_York');
  assert.equal(candles.length, 3);
  assert.equal(candles[0].ts.toISOString(), '2026-11-16T14:30:00.000Z');   // 09:30 ET en noviembre = 14:30 UTC
  assert.deepEqual([candles[0].o, candles[0].h, candles[0].l, candles[0].c], [27000, 27010, 26995, 27004]);
  assert.deepEqual(parseCandles('Error: sin datos').candles, []);
});

test('marketSnapshot calcula niveles a partir de las velas (martes antes de la apertura)', async () => {
  const calls = [];
  const mcp = {
    callTool: async (server, tool, input) => {
      calls.push(input);
      assert.equal(server, 'Tradezella');
      assert.equal(tool, 'get_market_data');
      const day = (iso) => new Date(iso).toLocaleString('sv', { timeZone: 'America/New_York' }).replace(' ', 'T').slice(0, 16);
      const from = day(input.from), to = day(input.to);
      return { payload: csvFor(from, to, from.startsWith('2026-11-16T09') ? 27000 : 27300) };
    },
  };
  // martes 17 nov 2026, 08:00 ET = 13:00 UTC
  const s = await marketSnapshot(mcp, 'mnq', new Date('2026-11-17T13:00:00Z'));
  assert.equal(s.symbol, 'NQ');                                    // el micro se consulta como el contrato grande
  assert.equal(s.sesionRegularAnterior.fecha, '2026-11-16');
  assert.equal(s.sesionRegularAnterior.open, 27000);
  assert.equal(s.hoySesionRegular, null);                          // aún no abrió la sesión regular
  assert.ok(s.nocheGlobex_18a0930.high > s.nocheGlobex_18a0930.low);
  assert.equal(s.gap.referencia, 'precio actual');
  assert.equal(s.hora, '2026-11-17 08:00 ET');
  assert.ok(s.ultimasVelas30m.length > 0 && s.ultimasVelas30m.length <= 8);
  assert.ok(calls.every((c) => c.interval === '30minute' && c.instrument_type === 'future'));
});

test('marketSnapshot falla con un mensaje claro si no hay velas', async () => {
  const mcp = { callTool: async () => ({ payload: 'sin datos' }) };
  await assert.rejects(() => marketSnapshot(mcp, 'XYZ', new Date('2026-11-17T13:00:00Z')), /No hay velas disponibles para XYZ/);
});
