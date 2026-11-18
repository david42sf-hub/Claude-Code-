// Análisis de noticias económicas y calculadora de tamaño de posición. Módulo puro.

const sum = (a) => a.reduce((s, x) => s + x, 0);

/**
 * Compara tus días con noticias de alto impacto contra los días sin ellas.
 * events: [{date:'YYYY-MM-DD', event}] ya filtrados por impacto y país.
 */
export function newsDayStats(trades, events) {
  const eventsByDay = new Map();
  for (const e of events) {
    if (!eventsByDay.has(e.date)) eventsByDay.set(e.date, new Set());
    eventsByDay.get(e.date).add(e.event);
  }
  const days = new Map();
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    let d = days.get(t.day);
    if (!d) { d = { day: t.day, net: 0, count: 0 }; days.set(t.day, d); }
    d.net += t.net; d.count++;
  }
  const side = (list) => {
    const winDays = list.filter((d) => d.net > 0).length;
    return {
      days: list.length, net: sum(list.map((d) => d.net)), trades: sum(list.map((d) => d.count)),
      avgDay: list.length ? sum(list.map((d) => d.net)) / list.length : null,
      winRate: list.length ? winDays / list.length : null,
    };
  };
  const all = [...days.values()];
  const news = all.filter((d) => eventsByDay.has(d.day));
  const calm = all.filter((d) => !eventsByDay.has(d.day));

  const perEvent = new Map();
  for (const d of news) for (const name of eventsByDay.get(d.day)) {
    if (!perEvent.has(name)) perEvent.set(name, []);
    perEvent.get(name).push(d);
  }
  const byEvent = [...perEvent].filter(([, list]) => list.length >= 2)
    .map(([name, list]) => ({ name, ...side(list) })).sort((a, b) => a.net - b.net);

  return { news: side(news), calm: side(calm), byEvent };
}

/**
 * Contratos que puedes operar arriesgando `risk` dólares con un stop de `stopPoints` puntos.
 * Incluye la comisión de ida y vuelta (`fee` por lado) en el riesgo de cada contrato.
 */
export function positionSize({ risk, stopPoints, multiplier, fee = 0 }) {
  if (!(risk > 0) || !(stopPoints > 0) || !(multiplier > 0)) return null;
  const stopDollars = stopPoints * multiplier;
  const perContract = stopDollars + 2 * Math.max(0, fee);
  const contracts = Math.floor(risk / perContract);
  return { stopDollars, perContract, contracts, riskUsed: contracts * perContract };
}
