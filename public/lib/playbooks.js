// Playbooks (estrategias) con reglas y estadísticas de cumplimiento. Módulo puro.
import { summarize } from './stats.js';

const sum = (a) => a.reduce((s, x) => s + x, 0);
const text = (v, n) => String(v ?? '').trim().slice(0, n);
const validId = (v) => (/^[A-Za-z0-9_-]{1,40}$/.test(String(v)) ? String(v) : '');

/** Sanea la lista de playbooks. Los ids de playbooks, grupos y reglas son únicos entre sí. */
export function normalizePlaybooks(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const uid = (v) => {
    let id = validId(v);
    while (!id || seen.has(id)) id = Math.random().toString(36).slice(2, 12);
    seen.add(id);
    return id;
  };
  return list.slice(0, 50).map((p) => ({
    id: uid(p?.id),
    name: text(p?.name, 80) || 'Sin nombre',
    description: text(p?.description, 1000),
    groups: (Array.isArray(p?.groups) ? p.groups : []).slice(0, 12).map((g) => ({
      id: uid(g?.id),
      name: text(g?.name, 80) || 'Reglas',
      rules: (Array.isArray(g?.rules) ? g.rules : []).slice(0, 30)
        .map((r) => ({ id: uid(r?.id), text: text(r?.text, 300) })).filter((r) => r.text),
    })),
  }));
}

/** Plantilla inicial para empezar a escribir un playbook. */
export function playbookTemplate(uid) {
  const g = (name, rules) => ({ id: uid(), name, rules: rules.map((t) => ({ id: uid(), text: t })) });
  return {
    id: uid(), name: 'Nuevo playbook', description: '',
    groups: [
      g('Condiciones de mercado', ['El contexto (tendencia o rango) encaja con este setup']),
      g('Criterios de entrada', ['La señal de entrada está confirmada', 'Entro en la zona definida, sin perseguir el precio']),
      g('Criterios de salida', ['El stop está colocado antes de entrar', 'Tengo definido el objetivo antes de entrar']),
      g('Gestión del riesgo', ['El riesgo de la operación está dentro de mi límite']),
    ],
  };
}

/** Reglas de un playbook en una lista plana. */
export const flatRules = (pb) => pb.groups.flatMap((g) => g.rules.map((r) => ({ ...r, group: g.name })));

/**
 * Rendimiento de un playbook y de cada una de sus reglas.
 * Las operaciones llevan `playbook` (id) y `followed` (ids de reglas cumplidas).
 */
export function playbookStats(all, pb) {
  const rules = flatRules(pb);
  const ids = new Set(rules.map((r) => r.id));
  const mine = all.filter((t) => t.playbook === pb.id && t.status === 'closed');
  const followedOf = (t) => (t.followed || []).filter((id) => ids.has(id));
  const adherence = (t) => (rules.length ? followedOf(t).length / rules.length : null);
  const part = (list) => { const s = summarize(list); return { count: list.length, net: s.net, winRate: s.winRate, expectancy: s.expectancy, profitFactor: s.profitFactor }; };

  const ruleStats = rules.map((r) => {
    const yes = mine.filter((t) => followedOf(t).includes(r.id));
    const no = mine.filter((t) => !followedOf(t).includes(r.id));
    const a = part(yes), b = part(no);
    return { ...r, followRate: mine.length ? yes.length / mine.length : null, followed: a, skipped: b };
  });

  let best = null;
  for (const r of ruleStats) {
    if (r.followed.count < 3 || r.skipped.count < 3) continue;
    const gap = r.followed.expectancy - r.skipped.expectancy;
    if (!best || gap > best.gap) best = { rule: r, gap };
  }

  return {
    count: mine.length, summary: summarize(mine), rules: ruleStats, best,
    adherence: rules.length && mine.length ? sum(mine.map(adherence)) / mine.length : null,
    complete: part(mine.filter((t) => rules.length && adherence(t) === 1)),
    incomplete: part(mine.filter((t) => rules.length && adherence(t) < 1)),
  };
}
