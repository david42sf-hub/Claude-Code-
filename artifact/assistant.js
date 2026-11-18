// Asistente de mercado para la página publicada. Usa a Claude (capacidad "sample") con herramientas
// que consultan datos reales: velas y calendario económico vía el conector de Tradezella (solo datos de
// mercado) y, si el usuario lo activa, un resumen de su propio diario.
import { wallToUtc, dayKey, parseTimestamp, isValidTz } from '../server/time.js';
import { parseCsv } from '../server/csv.js';
import { parseTradezellaCalendar } from '../server/economic.js';

const NY = 'America/New_York';
const SERVER = 'Tradezella';
const MAX_TOOL_CHARS = 7000;

const dateAdd = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekend = (day) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const at = (day, h, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return wallToUtc(y, mo, d, h, m, 0, NY); };
const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
const hhmm = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: NY, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(date);

const textOf = (r) => (typeof r?.payload === 'string' ? r.payload : (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
const clip = (s) => (s.length > MAX_TOOL_CHARS ? `${s.slice(0, MAX_TOOL_CHARS)}\n…(recortado)` : s);

const MCP_ERRORS = {
  needs_reauth: 'Hay que volver a conectar Tradezella en Claude.',
  server_not_connected: 'El conector de Tradezella no está añadido en Claude.',
  approval_required: 'El usuario no ha dado permiso para consultar datos de mercado.',
  blocked_by_policy: 'La organización no permite este conector.',
};
const mcpError = (e) => new Error(MCP_ERRORS[e?.code] || `Falló la consulta de datos de mercado (${e?.code || e?.message || 'error'}).`);

/** CSV de get_market_data: comentarios "# ..." con metadatos, línea en blanco y time,open,high,low,close,volume. */
export function parseCandles(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tzLine = lines.find((l) => /^#\s*time_zone:/i.test(l));
  const tzRaw = tzLine ? tzLine.split(':').slice(1).join(':').trim() : NY;
  const tz = isValidTz(tzRaw) ? tzRaw : NY;
  const rows = parseCsv(lines.filter((l) => !l.startsWith('#')).join('\n'));
  if (rows.length < 2) return { tz, candles: [] };
  const head = rows[0].map((x) => x.trim().toLowerCase());
  const ix = (n) => head.indexOf(n);
  const candles = rows.slice(1).map((r) => ({
    ts: parseTimestamp(r[ix('time')], tz), o: +r[ix('open')], h: +r[ix('high')], l: +r[ix('low')], c: +r[ix('close')], v: +r[ix('volume')],
  })).filter((c) => c.ts && isFinite(c.c));
  return { tz, candles };
}

async function fetchCandles(mcp, { symbol, type = 'future', from, to, interval }) {
  const now = new Date();
  const input = { symbol, instrument_type: type, from: (from > now ? now : from).toISOString(), to: to.toISOString(), interval };
  try { return parseCandles(textOf(await mcp.callTool(SERVER, 'get_market_data', input))).candles; } catch (e) { throw mcpError(e); }
}

const ohlc = (list) => (list.length ? {
  open: round(list[0].o), high: round(Math.max(...list.map((c) => c.h))), low: round(Math.min(...list.map((c) => c.l))), close: round(list[list.length - 1].c),
} : null);

/**
 * Niveles clave calculados en código a partir de velas reales de 30 minutos (horas en ET):
 * sesión regular anterior, noche (18:00-09:30), sesión europea (04:00-09:30), hoy y gap.
 */
export async function marketSnapshot(mcp, symbolIn = 'NQ', now = new Date()) {
  const symbol = String(symbolIn || 'NQ').toUpperCase().replace(/^M(NQ|ES|YM|RTY)$/, '$1');
  let sessionDay = dayKey(now, NY);
  while (isWeekend(sessionDay)) sessionDay = dateAdd(sessionDay, -1);

  let prevDay = null, prev = [];
  let cursor = sessionDay;
  for (let tries = 0; tries < 6 && !prev.length; tries++) {
    cursor = dateAdd(cursor, -1);
    if (isWeekend(cursor)) continue;
    const list = await fetchCandles(mcp, { symbol, from: at(cursor, 9, 30), to: at(cursor, 16), interval: '30minute' });
    if (list.length >= 6) { prev = list; prevDay = cursor; }
  }

  const start = at(dateAdd(sessionDay, -1), 18);
  const end = new Date(Math.min(now.getTime(), at(sessionDay, 16).getTime()));
  const recent = end > start ? await fetchCandles(mcp, { symbol, from: start, to: end, interval: '30minute' }) : [];
  if (!recent.length && !prev.length) throw new Error(`No hay velas disponibles para ${symbol}. Comprueba el símbolo.`);

  const open = at(sessionDay, 9, 30), euro = at(sessionDay, 4);
  const overnight = recent.filter((c) => c.ts >= start && c.ts < open);
  const europe = recent.filter((c) => c.ts >= euro && c.ts < open);
  const today = recent.filter((c) => c.ts >= open);
  const last = recent[recent.length - 1] || prev[prev.length - 1];
  const prevO = ohlc(prev), todayO = ohlc(today), ov = ohlc(overnight), eu = ohlc(europe);
  const ref = todayO ? todayO.open : round(last.c);
  return {
    symbol, zonaHoraria: 'America/New_York (ET)', hora: `${sessionDay} ${hhmm(now)} ET`,
    precioActual: round(last.c), ultimaVela: `${hhmm(last.ts)} ET`,
    sesionRegularAnterior: prevO && { fecha: prevDay, ...prevO },
    nocheGlobex_18a0930: ov && { ...ov, rango: round(ov.high - ov.low) },
    europa_04a0930: eu && { ...eu, rango: round(eu.high - eu.low) },
    hoySesionRegular: todayO,
    gap: prevO ? { puntos: round(ref - prevO.close), porcentaje: round(((ref - prevO.close) / prevO.close) * 100), referencia: todayO ? 'apertura de hoy' : 'precio actual' } : null,
    ultimasVelas30m: recent.slice(-8).map((c) => ({ hora: hhmm(c.ts), o: round(c.o), h: round(c.h), l: round(c.l), c: round(c.c), vol: c.v })),
  };
}

export const SYSTEM = (now, tz, { market, journal }) => `Eres el analista de mercado de un trader de futuros del Nasdaq (NQ y MNQ) que usa este diario de trading. Responde siempre en español, claro y directo.
Fecha y hora actuales: ${now} (${tz}).

Reglas:
- Todo precio, nivel, evento o cifra de mercado que menciones debe salir de los resultados de tus herramientas en esta conversación. Si no tienes la herramienta o falla, dilo y no estimes ni recuerdes cifras.
- No tienes acceso a noticias en texto ni a internet. Del calendario solo conoces lo que devuelve la herramienta. No inventes titulares ni causas de los movimientos; si propones una explicación, preséntala como hipótesis.
- ${market ? 'Para el premercado usa market_snapshot (niveles) y economic_calendar (eventos de hoy) y estructura la respuesta: contexto, niveles clave, eventos, escenarios (alcista, bajista, rango) con su nivel de invalidación y qué vigilar.' : 'Las herramientas de datos de mercado están desactivadas: no tienes precios ni calendario. Si te piden análisis de mercado, explica que hay que activar "Datos de mercado" encima del chat; solo puedes dar contexto general sin cifras.'}
- ${journal ? 'Tienes journal_summary con un resumen del diario del propio trader; úsalo cuando pregunte por su operativa y no inventes datos suyos.' : 'No tienes acceso al diario del trader; si pregunta por su operativa, dile que active "Resumen de mi diario".'}
- Es análisis educativo, no una recomendación de inversión ni una promesa de resultado.
- Sé breve salvo que pidan detalle. Usa listas o tablas cortas para niveles.`;

function buildTools({ market, journal, journalFn, status }) {
  const tools = [];
  if (market) {
    tools.push(
      {
        name: 'market_snapshot',
        description: 'Precio actual y niveles clave de un futuro (por defecto NQ): máximo, mínimo y cierre de la sesión regular anterior; máximo y mínimo de la noche (18:00-09:30 ET) y de la sesión europea; apertura y rango de hoy; gap y últimas velas de 30 min. Horas en ET. Úsala para premercado y estado actual.',
        inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'Raíz del futuro: NQ, ES, YM, RTY, CL, GC… Por defecto NQ.' } } },
        execute: async (input) => {
          status?.('Consultando precios y niveles…');
          const mcp = await globalThis.claude?.use?.('mcp');
          if (!mcp) throw new Error('No hay conexión con datos de mercado en esta vista.');
          return clip(JSON.stringify(await marketSnapshot(mcp, input?.symbol)));
        },
      },
      {
        name: 'get_candles',
        description: 'Velas OHLCV de cualquier símbolo en un rango (máximo 50 por llamada; usa intervalos mayores para rangos largos). from y to en ISO 8601 con zona horaria. Devuelve CSV con la hora en la zona indicada en la cabecera.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string' }, instrument_type: { type: 'string', description: 'future, stock, forex, crypto, cfd u option' },
            from: { type: 'string' }, to: { type: 'string' },
            interval: { type: 'string', description: 'minute, 5minute, 15minute, 30minute, hour, 4hour, day, week' },
          },
          required: ['symbol', 'instrument_type', 'from', 'to'],
        },
        execute: async (input) => {
          status?.(`Consultando velas de ${input?.symbol || ''}…`);
          const mcp = await globalThis.claude?.use?.('mcp');
          if (!mcp) throw new Error('No hay conexión con datos de mercado en esta vista.');
          try {
            return clip(textOf(await mcp.callTool(SERVER, 'get_market_data', {
              symbol: String(input.symbol), instrument_type: String(input.instrument_type), from: String(input.from), to: String(input.to),
              ...(input.interval ? { interval: String(input.interval) } : {}),
            })));
          } catch (e) { throw mcpError(e); }
        },
      },
      {
        name: 'economic_calendar',
        description: 'Eventos del calendario económico entre dos fechas (YYYY-MM-DD) con hora, país, impacto, previsión, anterior y dato real si ya salió. Horas en la zona horaria del trader. Filtra por impacto (high, medium, low) y país (US, EU, GB, JP…).',
        inputSchema: {
          type: 'object',
          properties: {
            start_date: { type: 'string' }, end_date: { type: 'string' },
            impact: { type: 'string', description: 'p. ej. high o high,medium' }, countries: { type: 'string', description: 'p. ej. US' },
          },
          required: ['start_date'],
        },
        execute: async (input) => {
          status?.('Consultando el calendario económico…');
          const mcp = await globalThis.claude?.use?.('mcp');
          if (!mcp) throw new Error('No hay conexión con datos de mercado en esta vista.');
          const args = { start_date: String(input.start_date), end_date: String(input.end_date || input.start_date) };
          if (input.impact) args.impact = String(input.impact);
          if (input.countries) args.countries = String(input.countries);
          try { return clip(JSON.stringify(parseTradezellaCalendar(textOf(await mcp.callTool(SERVER, 'get_economic_calendar', args))))); } catch (e) { throw mcpError(e); }
        },
      },
    );
  }
  if (journal && journalFn) {
    tools.push({
      name: 'journal_summary',
      description: 'Resumen del diario del propio trader en los últimos N días: resultado, tasa de acierto, factor de beneficio, rendimiento por día de la semana y por hora, cumplimiento de reglas y patrones de comportamiento detectados.',
      inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Días hacia atrás (por defecto 30)' } } },
      execute: async (input) => { status?.('Leyendo el resumen de tu diario…'); return clip(JSON.stringify(journalFn(Math.min(365, Math.max(1, Number(input?.days) || 30))))); },
    });
  }
  return tools;
}

/**
 * Pregunta al asistente. `messages` = [{role:'user'|'assistant', content}] terminando en 'user'.
 * opts: { market, journal, journalFn, onText, onStatus, signal, tz }
 */
export async function ask(messages, opts = {}) {
  const sample = await globalThis.claude?.use?.('sample');
  if (!sample) throw { code: 'unavailable', message: 'sample no disponible' };
  const now = new Date();
  const tz = opts.tz || NY;
  const stamp = new Intl.DateTimeFormat('es', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
  const turns = messages.map((m, i) => ({ role: m.role, content: i === 0 ? `${SYSTEM(stamp, tz, opts)}\n\n---\n\n${m.content}` : m.content }));
  const tools = buildTools({ ...opts, status: opts.onStatus });
  const limits = await sample.limits?.().catch(() => null);
  const usable = limits && !limits.tools ? [] : tools;
  return sample(turns, { tools: usable, onText: opts.onText, signal: opts.signal, cache: false, modelTier: 'default' });
}

globalThis.ASSISTANT = {
  isAvailable: async () => { try { return !!(await globalThis.claude?.use?.('sample')); } catch { return false; } },
  ask,
};
