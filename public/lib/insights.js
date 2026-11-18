// Reglas de disciplina e insights de comportamiento.
// Módulo puro: lo usan la interfaz, el servidor y las pruebas.

export const DEFAULT_RULES = {
  hours: { on: true, from: '09:30', to: '15:00' },
  maxLossDay: { on: false, value: 300 },
  maxLossTrade: { on: false, value: 150 },
  maxTradesDay: { on: false, value: 10 },
  pause: { on: true, losses: 2, minutes: 5 },
};

export const RULE_LABELS = {
  hours: 'Horario',
  maxLossDay: 'Pérdida máx. por día',
  maxLossTrade: 'Pérdida máx. por operación',
  maxTradesDay: 'Máx. operaciones por día',
  pause: 'Pausa tras pérdidas',
};

export const KIND_LABELS = {
  overtrading: 'Sobreoperación',
  revenge: 'Operaciones de venganza',
  overconfidence: 'Sobreconfianza',
  loser_hold: 'Pérdida aguantada de más',
  big_loss: 'Pérdida fuera de lo normal',
  perfect_day: 'Día perfecto',
};

const sum = (a) => a.reduce((s, x) => s + x, 0);
const money = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
const ms = (ts) => new Date(ts).getTime();
const byEntry = (a, b) => (a.entryTs < b.entryTs ? -1 : a.entryTs > b.entryTs ? 1 : 0);
const fmtDur = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

function groupBy(list, keyFn) {
  const map = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}

const time = (s, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)) ? String(s) : d);
const positive = (v, d) => (isFinite(+v) && +v > 0 ? +v : d);

/** Sanea la configuración de reglas; lo que falte o sea inválido toma el valor por defecto. */
export function normalizeRules(r) {
  const d = DEFAULT_RULES, x = r && typeof r === 'object' ? r : {};
  const on = (k) => (typeof x[k]?.on === 'boolean' ? x[k].on : d[k].on);
  return {
    hours: { on: on('hours'), from: time(x.hours?.from, d.hours.from), to: time(x.hours?.to, d.hours.to) },
    maxLossDay: { on: on('maxLossDay'), value: positive(x.maxLossDay?.value, d.maxLossDay.value) },
    maxLossTrade: { on: on('maxLossTrade'), value: positive(x.maxLossTrade?.value, d.maxLossTrade.value) },
    maxTradesDay: { on: on('maxTradesDay'), value: Math.floor(positive(x.maxTradesDay?.value, d.maxTradesDay.value)) },
    pause: {
      on: on('pause'),
      losses: Math.floor(positive(x.pause?.losses, d.pause.losses)),
      minutes: positive(x.pause?.minutes, d.pause.minutes),
    },
  };
}

const fmts = new Map();
/** Minuto del día (0-1439) de un instante en la zona `tz`. */
export function minuteOfDay(ts, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    fmts.set(tz, f);
  }
  const [h, m] = f.format(new Date(ts)).split(':').map(Number);
  return h * 60 + m;
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/**
 * Comprueba las reglas activas sobre operaciones cerradas.
 * Devuelve { rules, active, perTrade: Map(id -> [reglas rotas]), days, stats }.
 */
export function evaluateRules(all, rulesIn, tz) {
  const rules = normalizeRules(rulesIn);
  const active = Object.keys(RULE_LABELS).filter((k) => rules[k].on);
  const trades = all.filter((t) => t.status === 'closed');
  const perTrade = new Map();
  const flag = (t, key) => {
    const a = perTrade.get(t.id);
    if (!a) perTrade.set(t.id, [key]); else if (!a.includes(key)) a.push(key);
  };

  const days = [];
  for (const [day, dayTrades] of groupBy(trades, (t) => t.day)) {
    const failed = new Set();
    for (const list of groupBy(dayTrades, (t) => t.account).values()) {
      list.sort(byEntry);
      let streak = 0, prev = null;
      list.forEach((t, i) => {
        if (rules.hours.on) {
          const m = minuteOfDay(t.entryTs, tz), a = toMin(rules.hours.from), b = toMin(rules.hours.to);
          if (!(a <= b ? m >= a && m <= b : m >= a || m <= b)) flag(t, 'hours');
        }
        if (rules.maxLossTrade.on && t.net < -rules.maxLossTrade.value) flag(t, 'maxLossTrade');
        if (rules.maxTradesDay.on && i >= rules.maxTradesDay.value) flag(t, 'maxTradesDay');
        if (rules.pause.on && prev && streak >= rules.pause.losses) {
          const gap = ms(t.entryTs) - ms(prev.exitTs);
          if (gap >= 0 && gap < rules.pause.minutes * 60000) flag(t, 'pause');
        }
        streak = t.net < 0 ? streak + 1 : 0;
        prev = t;
      });
    }
    const net = sum(dayTrades.map((t) => t.net));
    if (rules.maxLossDay.on && net <= -rules.maxLossDay.value) failed.add('maxLossDay');
    for (const t of dayTrades) for (const k of perTrade.get(t.id) || []) failed.add(k);
    days.push({ day, count: dayTrades.length, net, failed: [...failed], ok: failed.size === 0 });
  }
  days.sort((a, b) => (a.day < b.day ? -1 : 1));

  const part = (list) => ({ count: list.length, net: sum(list.map((t) => t.net)), expectancy: list.length ? sum(list.map((t) => t.net)) / list.length : null });
  const stats = {
    days: days.length, okDays: days.filter((d) => d.ok).length,
    okRate: days.length ? days.filter((d) => d.ok).length / days.length : null,
    followed: part(trades.filter((t) => !perTrade.has(t.id))),
    broke: part(trades.filter((t) => perTrade.has(t.id))),
  };
  return { rules, active, perTrade, days, stats };
}

/** Patrones de comportamiento detectados a partir de las operaciones cerradas. */
export function behavioralInsights(all) {
  const trades = all.filter((t) => t.status === 'closed');
  const out = [];
  const byDay = groupBy(trades, (t) => t.day);
  const dayKeys = [...byDay.keys()].sort();
  const losers = trades.filter((t) => t.net < 0);
  const durations = losers.map((t) => t.durationS ?? 0).sort((a, b) => a - b);
  const medianLoserDur = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const avgLoss = losers.length ? sum(losers.map((t) => t.net)) / losers.length : 0;

  dayKeys.forEach((day, di) => {
    const dt = byDay.get(day);
    const net = sum(dt.map((t) => t.net));

    const prior = dayKeys.slice(Math.max(0, di - 60), di);
    if (prior.length >= 5) {
      const avg = sum(prior.map((d) => byDay.get(d).length)) / prior.length;
      if (dt.length >= 5 && dt.length > avg * 1.5) {
        out.push({
          kind: 'overtrading', severity: net < 0 ? 'negative' : 'neutral', day, impact: net,
          text: `Hiciste ${dt.length} operaciones, ${Math.round((dt.length / avg - 1) * 100)}% más que tu promedio de ${avg.toFixed(1)}.${net < 0 ? ` El día cerró en ${money(net)}.` : ''}`,
        });
      }
    }
    if (dt.length >= 3 && dt.every((t) => t.net > 0)) {
      out.push({ kind: 'perfect_day', severity: 'positive', day, impact: net, text: `${dt.length} operaciones y todas ganadoras: ${money(net)}. Repite lo que hiciste ese día.` });
    }

    for (const list of groupBy(dt, (t) => t.account).values()) {
      list.sort(byEntry);
      let winStreak = 0;
      const revenge = [];
      list.forEach((t, i) => {
        const prev = list[i - 1];
        if (prev && prev.net < 0) {
          const gap = ms(t.entryTs) - ms(prev.exitTs);
          if (gap >= 0 && gap <= 5 * 60000 && t.qty >= prev.qty) revenge.push(t);
        }
        if (i >= 2 && winStreak >= 2 && t.net < 0) {
          const avgQty = sum(list.slice(0, i).map((x) => x.qty)) / i;
          if (t.qty > avgQty * 1.5) {
            out.push({
              kind: 'overconfidence', severity: 'negative', day, tradeId: t.id, impact: t.net,
              text: `Subiste el tamaño a ${t.qty} contratos (tu media del día era ${avgQty.toFixed(1)}) tras ${winStreak} ganadoras seguidas y perdiste ${money(t.net)}.`,
            });
          }
        }
        winStreak = t.net > 0 ? winStreak + 1 : 0;
      });
      const cost = sum(revenge.map((t) => t.net));
      if (revenge.length >= 2 && cost < 0) {
        out.push({
          kind: 'revenge', severity: 'negative', day, impact: cost,
          text: `Reentraste ${revenge.length} veces en menos de 5 minutos justo después de perder, con el mismo tamaño o mayor. Esas operaciones sumaron ${money(cost)}.`,
        });
      }
    }
  });

  for (const t of losers) {
    if (losers.length < 8) break;
    if ((t.durationS ?? 0) > Math.max(300, medianLoserDur * 3)) {
      out.push({
        kind: 'loser_hold', severity: 'negative', day: t.day, tradeId: t.id, impact: t.net,
        text: `Aguantaste esta pérdida ${fmtDur(t.durationS)}; la mitad de tus pérdidas dura menos de ${fmtDur(medianLoserDur)}. Resultado: ${money(t.net)}.`,
      });
    }
    if (t.net < avgLoss * 3) {
      out.push({
        kind: 'big_loss', severity: 'negative', day: t.day, tradeId: t.id, impact: t.net,
        text: `Perdiste ${money(t.net)}, ${(t.net / avgLoss).toFixed(1)} veces tu pérdida media de ${money(avgLoss)}. Revisa dónde estaba el stop.`,
      });
    }
  }

  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.kind < b.kind ? -1 : 1));
}
