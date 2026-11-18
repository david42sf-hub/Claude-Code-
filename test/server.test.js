import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { tradovateConfig } from '../server/tradovate.js';

async function boot(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diario-'));
  const app = createApp({ dataDir, ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { ...app, call, base, close: () => { app.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

const CSV = [
  'symbol,buyFillId,sellFillId,qty,buyPrice,sellPrice,pnl,boughtTimestamp,soldTimestamp',
  'MNQZ6,101,102,1,20000.00,20010.00,$20.00,11/13/2026 09:30:00,11/13/2026 09:35:00',
  'ESZ6,201,202,2,5000.00,4990.00,$(1000.00),11/12/2026 10:00:00,11/12/2026 10:20:00',
].join('\n');

test('importar, anotar, reimportar sin duplicar y borrar', async () => {
  const app = await boot();
  try {
    let r = await app.call('POST', '/api/import', { csv: CSV, account: 'Real' });
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 4);
    r = await app.call('POST', '/api/import', { csv: CSV, account: 'Real' });
    assert.deepEqual([r.body.added, r.body.duplicates], [0, 4]);

    r = await app.call('GET', '/api/trades');
    assert.equal(r.body.length, 2);
    const es = r.body.find((t) => t.root === 'ES');
    assert.equal(es.net, -1000);
    assert.equal(es.day, '2026-11-12');

    r = await app.call('PUT', `/api/trades/${es.id}/meta`, { notes: 'Entré tarde', strategy: 'Ruptura', tags: ['A+', 'A+', ' '], stop: 4995 });
    assert.deepEqual([r.body.notes, r.body.strategy, r.body.tags, r.body.stop], ['Entré tarde', 'Ruptura', ['A+'], 4995]);

    // la comisión configurada se aplica a las operaciones ya importadas
    await app.call('PUT', '/api/instruments/ES', { multiplier: 50, fee: 1.5 });
    r = await app.call('GET', '/api/trades');
    const es2 = r.body.find((t) => t.root === 'ES');
    assert.deepEqual([es2.fees, es2.net, es2.notes], [6, -1006, 'Entré tarde']);

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    r = await app.call('POST', `/api/trades/${es.id}/shots`, { dataUrl: png });
    assert.equal(r.status, 201);
    const shot = r.body.shots[0];
    assert.equal((await fetch(`${app.base}/uploads/${shot}`)).status, 200);
    assert.equal((await app.call('POST', `/api/trades/${es.id}/shots`, { dataUrl: 'data:text/html;base64,AAAA' })).status, 400);

    r = await app.call('POST', '/api/trades', {
      contract: 'MNQZ6', side: 'short', qty: 3, entryPrice: 20000, exitPrice: 19996, fees: 3,
      entryTime: '2026-11-13T11:00', exitTime: '2026-11-13T11:10', account: 'Real',
    });
    assert.equal(r.status, 201);
    r = await app.call('GET', '/api/trades');
    const manual = r.body.find((t) => t.manual);
    assert.deepEqual([manual.side, manual.gross, manual.fees, manual.net], ['short', 24, 3, 21]);
    assert.equal((await app.call('POST', '/api/trades', { contract: 'ES', qty: 0 })).status, 400);

    assert.equal((await app.call('DELETE', `/api/trades/${es.id}`)).status, 200);
    assert.equal((await app.call('GET', '/api/trades')).body.length, 2);
    assert.equal((await fetch(`${app.base}/uploads/${shot}`)).status, 404);

    await app.call('PUT', '/api/days/2026-11-13', { notes: 'Buen día' });
    r = await app.call('GET', '/api/state');
    assert.equal(r.body.days['2026-11-13'], 'Buen día');
    assert.equal((await app.call('PUT', '/api/settings', { tz: 'Marte/Olimpo' })).status, 400);
    assert.equal((await app.call('POST', '/api/import', { csv: 'a,b\n1,2' })).status, 400);
  } finally { app.close(); }
});

test('las reglas de disciplina se guardan, se sanean y tienen valores por defecto', async () => {
  const app = await boot();
  try {
    let r = await app.call('GET', '/api/state');
    assert.deepEqual([r.body.settings.rules.hours.on, r.body.settings.rules.pause.minutes, r.body.settings.rules.maxLossDay.on], [true, 5, false]);
    r = await app.call('PUT', '/api/settings', { rules: { maxLossDay: { on: true, value: '250' }, hours: { from: '99:99' } } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.settings.rules.maxLossDay, r.body.settings.rules.hours.from], [{ on: true, value: 250 }, '09:30']);
    assert.equal((await app.call('GET', '/api/state')).body.settings.rules.maxLossDay.value, 250);
    assert.equal((await app.call('GET', '/api/state')).body.settings.tz, 'America/New_York');
  } finally { app.close(); }
});

test('borrar todos los datos deja la app vacía y conserva los ajustes', async () => {
  const app = await boot();
  try {
    await app.call('POST', '/api/import', { csv: CSV, account: 'Real' });
    const t = (await app.call('GET', '/api/trades')).body[0];
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const shot = (await app.call('POST', `/api/trades/${t.id}/shots`, { dataUrl: png })).body.shots[0];
    await app.call('PUT', '/api/days/2026-11-13', { notes: 'nota' });
    await app.call('PUT', '/api/settings', { tz: 'America/Chicago', playbooks: [{ id: 'p1', name: 'A', groups: [] }] });
    await app.call('PUT', '/api/instruments/NQ', { multiplier: 20, fee: 1.1 });
    assert.ok((await app.call('GET', '/api/state')).body.instruments.some((i) => i.root === 'ES'));

    assert.equal((await app.call('DELETE', '/api/data', {})).status, 400);               // exige confirmación
    const r = await app.call('DELETE', '/api/data', { confirm: 'BORRAR' });
    assert.equal(r.status, 200);
    assert.deepEqual((await app.call('GET', '/api/trades')).body, []);
    assert.equal(r.body.fills, 0);
    assert.deepEqual(r.body.days, {});
    assert.deepEqual(r.body.settings.playbooks, []);
    assert.equal(r.body.settings.tz, 'America/Chicago');
    assert.deepEqual(r.body.instruments.map((i) => [i.root, i.fee]), [['MNQ', 0], ['NQ', 1.1]]);
    assert.equal((await fetch(`${app.base}/uploads/${shot}`)).status, 404);
  } finally { app.close(); }
});

test('borrar operaciones en masa y borrar un archivo importado entero', async () => {
  const app = await boot();
  try {
    const csv2 = [
      'symbol,buyFillId,sellFillId,qty,buyPrice,sellPrice,pnl,boughtTimestamp,soldTimestamp',
      'MNQZ6,301,302,1,20000.00,20010.00,$20.00,11/16/2026 09:30:00,11/16/2026 09:35:00',
      'MNQZ6,303,304,2,20000.00,20005.00,$20.00,11/16/2026 10:00:00,11/16/2026 10:05:00',
    ].join('\n');
    await app.call('POST', '/api/import', { csv: CSV, account: 'Real', name: 'lunes.csv' });
    await app.call('POST', '/api/import', { csv: csv2, account: 'Real', name: 'martes.csv' });
    let r = await app.call('GET', '/api/state');
    assert.deepEqual(r.body.imports.map((i) => [i.name, i.fills]), [['martes.csv', 4], ['lunes.csv', 4]]);   // más reciente primero
    assert.equal((await app.call('POST', '/api/import', { csv: csv2, account: 'Real', name: 'repetido.csv' })).body.added, 0);
    assert.equal((await app.call('GET', '/api/state')).body.imports.length, 2);                              // un archivo sin novedades no se registra

    const trades = (await app.call('GET', '/api/trades')).body;
    assert.equal(trades.length, 4);
    const [a, b] = trades.filter((t) => t.root === 'MNQ');
    await app.call('PUT', `/api/trades/${a.id}/meta`, { notes: 'x' });
    assert.equal((await app.call('POST', '/api/trades/delete', { ids: [] })).status, 400);
    r = await app.call('POST', '/api/trades/delete', { ids: [a.id, b.id, 'no-existe'] });
    assert.deepEqual(r.body, { deleted: 2 });
    assert.equal((await app.call('GET', '/api/trades')).body.length, 2);
    assert.deepEqual((await app.call('GET', '/api/state')).body.imports.map((i) => [i.name, i.fills]), [['martes.csv', 2], ['lunes.csv', 2]]);

    r = await app.call('DELETE', `/api/imports/${(await app.call('GET', '/api/state')).body.imports[0].id}`);   // borra martes.csv
    assert.deepEqual(r.body, { fills: 2, trades: 1 });
    assert.deepEqual((await app.call('GET', '/api/trades')).body.map((t) => t.root), ['ES']);
    assert.deepEqual((await app.call('GET', '/api/state')).body.imports.map((i) => i.name), ['lunes.csv']);
  } finally { app.close(); }
});

test('archivos estáticos sin salir de la carpeta pública', async () => {
  const app = await boot();
  try {
    assert.equal((await fetch(`${app.base}/`)).status, 200);
    assert.equal((await fetch(`${app.base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${app.base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  } finally { app.close(); }
});

test('con contraseña, la API exige iniciar sesión', async () => {
  const app = await boot({ password: 'secreta' });
  try {
    assert.equal((await app.call('GET', '/api/trades')).status, 401);
    assert.equal((await app.call('POST', '/api/login', { password: 'mala' })).status, 401);
    const ok = await app.call('POST', '/api/login', { password: 'secreta' });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.call('GET', '/api/trades', null, { Cookie: cookie })).status, 200);
    assert.equal((await app.call('GET', '/api/trades', null, { Cookie: 'tj=' + '0'.repeat(64) })).status, 401);
  } finally { app.close(); }
});

test('sincronización con Tradovate (API simulada): mapea cuenta, contrato y comisiones', async () => {
  const calls = [];
  const fake = async (url, init = {}) => {
    calls.push(url);
    const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
    if (url.endsWith('/auth/accesstokenrequest')) {
      const b = JSON.parse(init.body);
      if (b.sec !== 's3c') return json({ errorText: 'Incorrect username or password' });
      return json({ accessToken: 'tok', expirationTime: new Date(Date.now() + 3600e3).toISOString() });
    }
    assert.equal(init.headers.Authorization, 'Bearer tok');
    if (url.endsWith('/fill/list')) return json([
      { id: 101, orderId: 9, contractId: 7, timestamp: '2026-11-13T14:30:00.000Z', action: 'Buy', qty: 1, price: 20000, active: true },
      { id: 102, orderId: 10, contractId: 7, timestamp: '2026-11-13T14:35:00.000Z', action: 'Sell', qty: 1, price: 20010, active: true },
      { id: 103, orderId: 10, contractId: 7, timestamp: '2026-11-13T14:36:00.000Z', action: 'Sell', qty: 1, price: 1, active: false },
    ]);
    if (url.endsWith('/order/list')) return json([{ id: 9, accountId: 55 }, { id: 10, accountId: 55 }]);
    if (url.endsWith('/account/list')) return json([{ id: 55, name: 'LIVE123' }]);
    if (url.endsWith('/fillFee/list')) return json([{ id: 101, commission: 0.25, exchangeFee: 0.35, nfaFee: 0.02 }, { id: 102, commission: 0.25, exchangeFee: 0.35, nfaFee: 0.02 }]);
    if (url.includes('/contract/items?ids=7')) return json([{ id: 7, name: 'MNQZ6' }]);
    return json({}, 404);
  };
  const cfg = tradovateConfig({ TRADOVATE_USER: 'u', TRADOVATE_PASSWORD: 'p', TRADOVATE_CID: '1', TRADOVATE_SEC: 's3c' });
  const app = await boot({ tradovate: cfg, fetchImpl: fake });
  try {
    // una importación previa del mismo fill no debe duplicarse
    await app.call('POST', '/api/import', { csv: CSV, account: 'Etiqueta CSV' });
    const r = await app.call('POST', '/api/sync');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2);
    assert.ok(calls[0].startsWith('https://live.tradovateapi.com/v1/'));
    const trades = (await app.call('GET', '/api/trades')).body;
    const mnq = trades.filter((t) => t.root === 'MNQ');
    assert.equal(mnq.length, 1);
    assert.deepEqual([mnq[0].account, mnq[0].gross, mnq[0].fees, mnq[0].net], ['LIVE123', 20, 1.24, 18.76]);
    assert.equal((await app.call('GET', '/api/state')).body.sync.lastError, null);
  } finally { app.close(); }

  const bad = await boot({ tradovate: { ...cfg, sec: 'x' }, fetchImpl: fake });
  try {
    const r = await bad.call('POST', '/api/sync');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /rechazó las credenciales/);
  } finally { bad.close(); }
});
