import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaybooks, playbookTemplate, playbookStats, flatRules } from '../public/lib/playbooks.js';
import { newsDayStats, positionSize } from '../public/lib/news.js';
import { heatmap } from '../public/lib/stats.js';
import { parseTradezellaCalendar, mapPublicFeed, filterEvents } from '../server/economic.js';

const pb = normalizePlaybooks([{
  id: 'p1', name: ' Ruptura ', groups: [
    { id: 'g1', name: 'Entrada', rules: [{ id: 'r1', text: 'Confirmación' }, { id: 'r2', text: 'Volumen' }, { id: 'r3', text: '   ' }] },
    { id: 'g2', name: 'Riesgo', rules: [{ id: 'r4', text: 'Stop puesto' }] },
  ],
}])[0];
const tr = (id, net, followed, playbook = 'p1') => ({ id, net, playbook, followed, status: 'closed', day: '2026-11-10', exitTs: `2026-11-10T15:${String(id).padStart(2, '0')}:00Z`, durationS: 60, gross: net, fees: 0, qty: 1 });

test('normalizePlaybooks limpia textos, descarta reglas vacías y deja ids únicos', () => {
  assert.equal(pb.name, 'Ruptura');
  assert.deepEqual(flatRules(pb).map((r) => r.id), ['r1', 'r2', 'r4']);
  const dup = normalizePlaybooks([{ id: 'x', groups: [{ id: 'x', rules: [{ id: 'x', text: 'a' }] }] }, 'basura', null]);
  const ids = [dup[0].id, dup[0].groups[0].id, dup[0].groups[0].rules[0].id];
  assert.equal(new Set(ids).size, 3);
  assert.equal(dup[1].name, 'Sin nombre');
  assert.deepEqual(normalizePlaybooks('no'), []);
  let n = 0;
  const t = playbookTemplate(() => `id${++n}`);
  assert.equal(t.groups.length, 4);
  assert.equal(normalizePlaybooks([t])[0].groups[1].rules.length, 2);
});

test('playbookStats: cumplimiento medio, reglas y la que más separa tus resultados', () => {
  const trades = [
    tr(1, 100, ['r1', 'r2', 'r4']), tr(2, 80, ['r1', 'r2', 'r4']), tr(3, 60, ['r1', 'r2', 'r4']),
    tr(4, -50, ['r1']), tr(5, -70, []), tr(6, -30, ['r2']),
    tr(7, 999, ['r1'], 'otro'),
  ];
  const s = playbookStats(trades, pb);
  assert.equal(s.count, 6);
  assert.equal(s.summary.net, 90);
  assert.ok(Math.abs(s.adherence - (3 + 3 + 3 + 1 + 0 + 1) / 18) < 1e-9);
  assert.deepEqual([s.complete.count, s.complete.net, s.incomplete.count, s.incomplete.net], [3, 240, 3, -150]);
  const r4 = s.rules.find((r) => r.id === 'r4');
  assert.deepEqual([r4.followed.count, r4.skipped.count, r4.followed.net, r4.skipped.net], [3, 3, 240, -150]);
  assert.equal(r4.followRate, 0.5);
  assert.equal(s.best.rule.id, 'r4');                    // cumplirla separa 80 vs −50 por operación
  assert.equal(playbookStats([], pb).adherence, null);
});

test('newsDayStats compara días con noticias y días sin ellas', () => {
  const t = (day, net) => ({ status: 'closed', day, net });
  const trades = [t('2026-11-10', 100), t('2026-11-10', -20), t('2026-11-11', -50), t('2026-11-12', 30), t('2026-11-13', -10), t('2026-11-13', -10)];
  const events = [{ date: '2026-11-10', event: 'CPI' }, { date: '2026-11-12', event: 'CPI' }, { date: '2026-11-13', event: 'PPI' }];
  const r = newsDayStats(trades, events);
  assert.deepEqual([r.news.days, r.news.net, r.news.trades], [3, 90, 5]);
  assert.deepEqual([r.calm.days, r.calm.net], [1, -50]);
  assert.equal(r.news.winRate, 2 / 3);
  assert.deepEqual(r.byEvent.map((e) => [e.name, e.days, e.net]), [['CPI', 2, 110]]);   // PPI tiene un solo día
});

test('positionSize incluye la comisión de ida y vuelta y redondea hacia abajo', () => {
  assert.deepEqual(positionSize({ risk: 100, stopPoints: 10, multiplier: 2, fee: 0.5 }), { stopDollars: 20, perContract: 21, contracts: 4, riskUsed: 84 });
  assert.equal(positionSize({ risk: 10, stopPoints: 10, multiplier: 2 }).contracts, 0);
  assert.equal(positionSize({ risk: 0, stopPoints: 10, multiplier: 2 }), null);
  assert.equal(positionSize({ risk: 100, stopPoints: 'x', multiplier: 2 }), null);
});

test('heatmap agrupa por día de la semana y hora de entrada', () => {
  const t = (day, hour, net) => ({ status: 'closed', day, hour, net });
  const cells = heatmap([t('2026-11-09', 9, 10), t('2026-11-09', 9, -4), t('2026-11-10', 14, 5), { status: 'open', day: '2026-11-09', hour: 9, net: 99 }]);
  const mon9 = cells.find((c) => c.dow === 1 && c.hour === 9);
  assert.deepEqual([mon9.net, mon9.count, mon9.wins], [6, 2, 1]);
  assert.equal(cells.length, 2);
});

test('calendario económico: CSV de Tradezella, feed público y filtros', () => {
  const csv = 'date,time,country,event,impact,forecast,previous,actual,unit\n2026-11-10,08:30,US,"Core Inflation Rate, MoM",high,0.2,0.3,0.3,%\n2026-11-12,10:00,US,Existing Home Sales,medium,3.85,3.97,3.75,""\nbasura,,,,,,,,\n';
  const ev = parseTradezellaCalendar(csv);
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0].event, ev[0].impact, ev[0].actual, ev[0].unit], ['Core Inflation Rate, MoM', 'high', '0.3', '%']);
  assert.deepEqual(parseTradezellaCalendar('algo,distinto\n1,2'), []);
  assert.deepEqual(parseTradezellaCalendar(''), []);

  const feed = [
    { title: 'CPI m/m', country: 'USD', date: '2026-11-10T08:30:00-05:00', impact: 'High', forecast: '0.2%', previous: '0.3%' },
    { title: 'Bank Holiday', country: 'JPY', date: '2026-11-10T19:00:00-05:00', impact: 'Holiday' },
    { title: 'Tarde', country: 'EUR', date: '2026-11-10T23:30:00-05:00', impact: 'Low' },
  ];
  const mapped = mapPublicFeed(feed, 'America/New_York');
  assert.deepEqual(mapped.map((e) => [e.date, e.time, e.impact]), [['2026-11-10', '08:30', 'high'], ['2026-11-10', '23:30', 'low']]);
  assert.equal(mapPublicFeed(feed, 'UTC')[1].date, '2026-11-11');                    // la zona horaria mueve el día
  assert.deepEqual(filterEvents(mapped, { impact: 'high', countries: 'usd' }).map((e) => e.event), ['CPI m/m']);
  assert.equal(filterEvents(mapped, { from: '2026-11-11' }).length, 0);
});
