// Calendario económico: lectura del CSV de Tradezella y del feed público semanal.
import { parseCsv } from './csv.js';
import { tzParts } from './time.js';

export const PUBLIC_FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/** CSV de get_economic_calendar: date,time,country,event,impact,forecast,previous,actual,unit */
export function parseTradezellaCalendar(csv) {
  const rows = parseCsv(String(csv || ''));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const c = Object.fromEntries(['date', 'time', 'country', 'event', 'impact', 'forecast', 'previous', 'actual', 'unit'].map((n) => [n, col(n)]));
  if (c.date < 0 || c.event < 0) return [];
  return rows.slice(1).map((r) => ({
    date: (r[c.date] || '').trim(), time: (r[c.time] || '').trim(), country: (r[c.country] || '').trim(),
    event: (r[c.event] || '').trim(), impact: (r[c.impact] || '').trim().toLowerCase(),
    forecast: (r[c.forecast] || '').trim(), previous: (r[c.previous] || '').trim(),
    actual: (r[c.actual] || '').trim(), unit: (r[c.unit] || '').trim(),
  })).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.event);
}

/** Feed público (JSON) a la misma forma, con fecha y hora en la zona `tz`. */
export function mapPublicFeed(json, tz) {
  const pad = (n) => String(n).padStart(2, '0');
  return (Array.isArray(json) ? json : []).filter((e) => e && e.date && /^(high|medium|low)$/i.test(e.impact || ''))
    .map((e) => {
      const d = new Date(e.date);
      if (isNaN(d)) return null;
      const p = tzParts(d, tz);
      return {
        date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}`, country: String(e.country || ''),
        event: String(e.title || ''), impact: e.impact.toLowerCase(), forecast: String(e.forecast || ''),
        previous: String(e.previous || ''), actual: String(e.actual || ''), unit: '',
      };
    }).filter(Boolean).sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
}

/** Aplica los filtros de fecha, impacto y país que usa la interfaz. */
export function filterEvents(events, { from, to, impact, countries } = {}) {
  const imp = impact ? new Set(String(impact).toLowerCase().split(',').map((s) => s.trim())) : null;
  const cty = countries ? new Set(String(countries).toUpperCase().split(',').map((s) => s.trim())) : null;
  return events.filter((e) => (!from || e.date >= from) && (!to || e.date <= to)
    && (!imp || imp.has(e.impact)) && (!cty || cty.has(e.country.toUpperCase())));
}
