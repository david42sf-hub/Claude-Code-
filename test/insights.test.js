import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRules, evaluateRules, behavioralInsights, minuteOfDay, DEFAULT_RULES } from '../public/lib/insights.js';

// Operación mínima: hora de entrada y salida en UTC, "HH:MM".
let n = 0;
const mk = (day, entry, exit, net, qty = 1, account = 'A') => ({
  id: `t${++n}`, account, day, qty, net, status: 'closed',
  entryTs: `${day}T${entry}:00.000Z`, exitTs: `${day}T${exit}:00.000Z`,
  durationS: (Date.parse(`${day}T${exit}:00Z`) - Date.parse(`${day}T${entry}:00Z`)) / 1000,
});

test('normalizeRules rellena, sanea y respeta lo válido', () => {
  assert.deepEqual(normalizeRules(undefined), DEFAULT_RULES);
  const r = normalizeRules({ hours: { on: false, from: '25:00', to: '16:30' }, maxLossDay: { on: true, value: '-5' }, maxTradesDay: { on: true, value: 7.9 }, pause: { losses: 'x', minutes: 10 } });
  assert.deepEqual(r.hours, { on: false, from: '09:30', to: '16:30' });
  assert.deepEqual(r.maxLossDay, { on: true, value: 300 });
  assert.equal(r.maxTradesDay.value, 7);
  assert.deepEqual(r.pause, { on: true, losses: 2, minutes: 10 });
});

test('minuteOfDay respeta la zona horaria', () => {
  assert.equal(minuteOfDay('2026-11-13T14:30:00.000Z', 'America/New_York'), 9 * 60 + 30);
  assert.equal(minuteOfDay('2026-11-13T14:30:00.000Z', 'UTC'), 14 * 60 + 30);
});

test('reglas: horario, pausa, pérdida por operación y máximo de operaciones', () => {
  const trades = [
    mk('2026-11-12', '08:00', '08:10', 50),           // fuera de horario
    mk('2026-11-12', '10:00', '10:05', -40),
    mk('2026-11-12', '10:10', '10:20', -60),
    mk('2026-11-12', '10:22', '10:30', -200),         // 2 pérdidas seguidas y entra 2 min después; pierde más de 150
    mk('2026-11-12', '10:50', '11:00', 30),           // pausa respetada (20 min)
  ];
  const rules = { hours: { on: true, from: '09:30', to: '15:00' }, pause: { on: true, losses: 2, minutes: 5 }, maxLossTrade: { on: true, value: 150 }, maxTradesDay: { on: true, value: 4 } };
  const ev = evaluateRules(trades, rules, 'UTC');
  assert.deepEqual(ev.active.sort(), ['hours', 'maxLossTrade', 'maxTradesDay', 'pause']);
  assert.deepEqual(ev.perTrade.get(trades[0].id), ['hours']);
  assert.equal(ev.perTrade.has(trades[1].id), false);
  assert.deepEqual(ev.perTrade.get(trades[3].id).sort(), ['maxLossTrade', 'pause']);
  assert.deepEqual(ev.perTrade.get(trades[4].id), ['maxTradesDay']);   // la quinta supera el máximo de 4
  assert.equal(ev.days.length, 1);
  assert.equal(ev.days[0].ok, false);
  assert.equal(ev.stats.okDays, 0);
  assert.equal(ev.stats.broke.count, 3);
  assert.equal(ev.stats.followed.count, 2);
  assert.equal(ev.stats.broke.net, 50 - 200 + 30);
});

test('reglas: pérdida máxima del día y días cumplidos', () => {
  const trades = [
    mk('2026-11-10', '10:00', '10:10', 80), mk('2026-11-10', '11:00', '11:10', 20),
    mk('2026-11-11', '10:00', '10:10', -250), mk('2026-11-11', '11:00', '11:10', -100),
  ];
  const ev = evaluateRules(trades, { hours: { on: false }, pause: { on: false }, maxLossDay: { on: true, value: 300 } }, 'UTC');
  assert.deepEqual(ev.days.map((d) => [d.day, d.ok, d.failed]), [['2026-11-10', true, []], ['2026-11-11', false, ['maxLossDay']]]);
  assert.equal(ev.stats.okRate, 0.5);
});

test('reglas: una entrada anterior a la salida de la pérdida no cuenta como reacción', () => {
  const trades = [mk('2026-11-12', '10:00', '10:05', -10), mk('2026-11-12', '10:06', '10:20', -10), mk('2026-11-12', '10:10', '10:30', 5)];
  const ev = evaluateRules(trades, { hours: { on: false }, pause: { on: true, losses: 2, minutes: 5 } }, 'UTC');
  assert.equal(ev.perTrade.size, 0);
});

test('insights: sobreoperación, venganza, sobreconfianza y día perfecto', () => {
  const t = [];
  for (let d = 2; d <= 8; d++) { const day = `2026-10-${String(d).padStart(2, '0')}`; t.push(mk(day, '10:00', '10:10', 10), mk(day, '11:00', '11:10', -5)); }
  // día de sobreoperación: 6 operaciones, termina en pérdida
  for (let i = 0; i < 6; i++) t.push(mk('2026-10-09', `1${i}:00`, `1${i}:05`, i < 2 ? 5 : -20));
  // venganza: pierde y reentra enseguida dos veces perdiendo
  t.push(mk('2026-10-12', '10:00', '10:10', -30), mk('2026-10-12', '10:12', '10:20', -30), mk('2026-10-12', '10:22', '10:30', -30));
  // sobreconfianza: dos ganadoras de 1 contrato y una perdedora de 3
  t.push(mk('2026-10-13', '10:00', '10:05', 20), mk('2026-10-13', '10:10', '10:15', 20), mk('2026-10-13', '10:20', '10:25', -90, 3));
  // día perfecto
  t.push(mk('2026-10-14', '10:00', '10:05', 20), mk('2026-10-14', '10:10', '10:15', 20), mk('2026-10-14', '10:20', '10:25', 20));
  const ins = behavioralInsights(t);
  const kinds = (day) => ins.filter((i) => i.day === day).map((i) => i.kind).sort();
  assert.deepEqual(kinds('2026-10-09'), ['overtrading']);
  assert.ok(ins.find((i) => i.kind === 'overtrading').text.includes('El día cerró en'));
  assert.deepEqual(kinds('2026-10-12'), ['revenge']);
  assert.equal(ins.find((i) => i.kind === 'revenge').impact, -60);
  assert.deepEqual(kinds('2026-10-13'), ['big_loss', 'overconfidence']);   // −90 también supera 3× la pérdida media
  assert.deepEqual(kinds('2026-10-14'), ['perfect_day']);
  assert.deepEqual(kinds('2026-10-05'), []);
  assert.equal(ins[0].day, '2026-10-14');                // más recientes primero
});

test('insights: pérdida aguantada y pérdida fuera de lo normal necesitan historial suficiente', () => {
  const few = [mk('2026-10-01', '10:00', '12:00', -500)];
  assert.deepEqual(behavioralInsights(few), []);
  const t = [];
  for (let d = 1; d <= 9; d++) t.push(mk(`2026-10-${String(d).padStart(2, '0')}`, '10:00', '10:03', -10));
  t.push(mk('2026-10-10', '10:00', '11:00', -100));
  const kinds = behavioralInsights(t).map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['big_loss', 'loser_hold']);
});
