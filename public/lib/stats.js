// Cálculo de métricas. Módulo puro: lo usan la interfaz y las pruebas.

const sum = (a) => a.reduce((s, x) => s + x, 0);

/** R múltiple de una operación si tiene stop definido. */
export function rMultiple(t) {
  if (t.stop == null || t.entryPrice == null) return null;
  const risk = Math.abs(t.entryPrice - t.stop) * t.mult * t.qty;
  return risk > 0 ? t.net / risk : null;
}

/** Métricas de un conjunto de operaciones cerradas. */
export function summarize(all) {
  const trades = all.filter((t) => t.status === 'closed')
    .sort((a, b) => (a.exitTs < b.exitTs ? -1 : a.exitTs > b.exitTs ? 1 : 0));
  const wins = trades.filter((t) => t.net > 0), losses = trades.filter((t) => t.net < 0);
  const grossWin = sum(wins.map((t) => t.net)), grossLoss = -sum(losses.map((t) => t.net));
  const net = sum(trades.map((t) => t.net));

  let equity = 0, peak = 0, maxDD = 0, streak = 0, maxWinStreak = 0, maxLossStreak = 0;
  const curve = [];
  for (const t of trades) {
    equity += t.net;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    curve.push({ ts: t.exitTs, day: t.day, value: equity });
    if (t.net > 0) { streak = streak > 0 ? streak + 1 : 1; maxWinStreak = Math.max(maxWinStreak, streak); }
    else if (t.net < 0) { streak = streak < 0 ? streak - 1 : -1; maxLossStreak = Math.max(maxLossStreak, -streak); }
  }

  const days = dailySeries(trades);
  const winDays = days.filter((d) => d.net > 0).length, lossDays = days.filter((d) => d.net < 0).length;
  const rs = trades.map(rMultiple).filter((r) => r != null);
  const dur = (list) => (list.length ? sum(list.map((t) => t.durationS || 0)) / list.length : null);
  const decided = wins.length + losses.length;

  return {
    count: trades.length, wins: wins.length, losses: losses.length, breakeven: trades.length - decided,
    net, gross: sum(trades.map((t) => t.gross)), fees: sum(trades.map((t) => t.fees)),
    winRate: decided ? wins.length / decided : null,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: trades.length ? net / trades.length : null,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.net)) : null,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.net)) : null,
    maxDrawdown: maxDD, maxWinStreak, maxLossStreak,
    avgDuration: dur(trades), avgWinDuration: dur(wins), avgLossDuration: dur(losses),
    contracts: sum(trades.map((t) => t.qty)),
    avgR: rs.length ? sum(rs) / rs.length : null, rCount: rs.length,
    tradingDays: days.length, winDays, lossDays,
    dayWinRate: winDays + lossDays ? winDays / (winDays + lossDays) : null,
    bestDay: days.length ? days.reduce((a, b) => (b.net > a.net ? b : a)) : null,
    worstDay: days.length ? days.reduce((a, b) => (b.net < a.net ? b : a)) : null,
    curve, days,
  };
}

/** Resultado neto por día, ordenado, con acumulado. */
export function dailySeries(trades) {
  const map = new Map();
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    let d = map.get(t.day);
    if (!d) { d = { day: t.day, net: 0, count: 0, wins: 0, losses: 0 }; map.set(t.day, d); }
    d.net += t.net; d.count++;
    if (t.net > 0) d.wins++; else if (t.net < 0) d.losses++;
  }
  const days = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  let cum = 0;
  for (const d of days) { cum += d.net; d.cum = cum; }
  return days;
}

/** Agrupa por una clave (o varias, si keyFn devuelve un arreglo) y resume cada grupo. */
export function groupStats(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    const keys = [].concat(keyFn(t));
    for (const k of keys) {
      if (k == null || k === '') continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
  }
  return [...groups].map(([key, list]) => {
    const s = summarize(list);
    return { key, count: s.count, net: s.net, winRate: s.winRate, profitFactor: s.profitFactor, expectancy: s.expectancy, avgWin: s.avgWin, avgLoss: s.avgLoss };
  });
}

export const DURATION_BUCKETS = [
  ['< 1 min', 60], ['1–5 min', 300], ['5–15 min', 900], ['15–60 min', 3600], ['1–4 h', 14400], ['> 4 h', Infinity],
];
export function durationBucket(t) {
  const s = t.durationS ?? 0;
  return DURATION_BUCKETS.find(([, max]) => s < max)[0];
}

/** Resultado por día de la semana y hora de entrada. */
export function heatmap(trades) {
  const cells = new Map();
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    const dow = weekday(t.day), key = `${dow}-${t.hour}`;
    let c = cells.get(key);
    if (!c) { c = { dow, hour: t.hour, net: 0, count: 0, wins: 0 }; cells.set(key, c); }
    c.net += t.net; c.count++;
    if (t.net > 0) c.wins++;
  }
  return [...cells.values()];
}

/** Día de la semana (0 = domingo) de una clave "YYYY-MM-DD". */
export function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
