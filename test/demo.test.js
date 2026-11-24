import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo } from '../artifact/demo.js';
import { buildTrades } from '../server/engine.js';
import { evaluateRules, behavioralInsights, normalizeRules } from '../public/lib/insights.js';
import { playbookStats, normalizePlaybooks } from '../public/lib/playbooks.js';
import { summarize } from '../public/lib/stats.js';

const NOW = new Date('2026-11-24T15:00:00Z');
const d = makeDemo(NOW, 'America/New_York');
const inst = new Map(Object.entries(d.instruments).map(([root, v]) => [root, { root, ...v, fee: v.fee / 2 }]));   // comisión por contrato, una vez
const trades = buildTrades(d.fills, inst, 'America/New_York').map((t) => ({ ...t, ...(d.meta[t.id] || {}), playbook: d.meta[t.id]?.playbook || '', followed: d.meta[t.id]?.followed || [] }));

test('datos de ejemplo: deterministas y con un volumen razonable', () => {
  assert.deepEqual(makeDemo(NOW, 'America/New_York'), d);
  assert.ok(trades.length > 80 && trades.length < 300, `operaciones: ${trades.length}`);
  assert.equal(trades.filter((t) => t.status === 'open').length, 0);
  assert.ok(trades.every((t) => !t.unknownInstrument));
  assert.deepEqual([...new Set(trades.map((t) => t.root))].sort(), ['MNQ', 'NQ']);
  assert.ok(d.fills.every((f) => f.batch === 'demo' && f.source === 'csv'));
  assert.equal(new Set(d.fills.map((f) => f.id)).size, d.fills.length);
  assert.ok(trades.every((t) => t.exitTs < NOW.toISOString()));                                  // nada en el futuro
});

test('datos de ejemplo: resultados creíbles y comisiones descontadas', () => {
  const s = summarize(trades);
  assert.ok(s.winRate > 0.4 && s.winRate < 0.75, `acierto ${s.winRate}`);
  assert.ok(s.fees > 0 && s.net < s.gross);
  assert.ok(s.tradingDays > 30);
});

test('datos de ejemplo: hay material para disciplina, insights y playbooks', () => {
  const ev = evaluateRules(trades, normalizeRules(), 'America/New_York');
  assert.ok(ev.stats.broke.count > 0, 'alguna operación rompe reglas');
  assert.ok(ev.stats.okDays > 0 && ev.stats.okDays < ev.stats.days);
  const kinds = new Set(behavioralInsights(trades).map((i) => i.kind));
  for (const k of ['overtrading', 'revenge', 'perfect_day']) assert.ok(kinds.has(k), `falta ${k}`);
  const pbs = normalizePlaybooks(d.playbooks);
  assert.deepEqual(pbs.map((p) => p.id), ['demo-pb1', 'demo-pb2']);                              // los ids se conservan
  const st = playbookStats(trades, pbs[0]);
  assert.ok(st.count > 10 && st.adherence > 0.4 && st.adherence < 1);
  assert.ok(Object.keys(d.days).length > 0);
});
