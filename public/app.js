import { summarize, groupStats, rMultiple, durationBucket, DURATION_BUCKETS, weekday } from '/lib/stats.js';
import { lineChart, columnChart, hbarChart, hideTip } from '/charts.js';

// ---------- utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v, { sign = true } = {}) => {
  if (v == null || !isFinite(v)) return '—';
  const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : sign && v > 0 ? '+' : ''}$${body}`;
};
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const price = (v) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 6 }));
const duration = (s) => {
  if (s == null) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
};
const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const dayDate = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmtDay = (day, opts = { day: 'numeric', month: 'short' }) => dayDate(day).toLocaleDateString('es', { ...opts, timeZone: 'UTC' });
const fmtDayLong = (day) => fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => { const d = dayDate(day); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

let S = {
  state: null, trades: [], needLogin: false,
  filter: { range: 'all', from: '', to: '', account: '', symbol: '', side: '' },
  sort: { key: 'time', dir: -1 }, calMonth: null, reportTab: 'symbol', openId: null, page: 1,
};
const tz = () => S.state.settings.tz;
const fmtTime = (ts, withDate = true) => (ts ? new Date(ts).toLocaleString('es', {
  timeZone: tz(), ...(withDate ? { day: '2-digit', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}) : '—');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date());

// Funciones que dependen de dónde corre la app (servidor propio o página publicada).
const feat = (name) => S.state?.features?.[name] ?? true;

async function api(method, url, body) {
  if (globalThis.LOCAL_BACKEND) return globalThis.LOCAL_BACKEND(method, url, body);
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { S.needLogin = true; render(); throw new Error('Inicia sesión.'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}
async function load() {
  [S.state, S.trades] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/trades')]);
  S.needLogin = false;
}
async function reload() { await load(); render(); }

// ---------- filtros ----------
function rangeBounds() {
  const f = S.filter, t = today();
  const first = (d) => `${d.slice(0, 8)}01`;
  switch (f.range) {
    case 'today': return [t, t];
    case 'week': { const wd = (weekday(t) + 6) % 7; return [addDays(t, -wd), t]; }
    case 'month': return [first(t), t];
    case 'lastMonth': { const end = addDays(first(t), -1); return [first(end), end]; }
    case 'year': return [`${t.slice(0, 4)}-01-01`, t];
    case 'custom': return [f.from || '0000-00-00', f.to || '9999-99-99'];
    default: return ['0000-00-00', '9999-99-99'];
  }
}
function filtered({ ignoreRange = false } = {}) {
  const f = S.filter, [from, to] = rangeBounds();
  return S.trades.filter((t) => (ignoreRange || (t.day >= from && t.day <= to))
    && (!f.account || t.account === f.account) && (!f.symbol || t.root === f.symbol) && (!f.side || t.side === f.side));
}
const uniq = (key) => [...new Set(S.trades.map((t) => t[key]))].sort();
function filterBar() {
  const f = S.filter;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const ranges = [['all', 'Todo el historial'], ['today', 'Hoy'], ['week', 'Esta semana'], ['month', 'Este mes'], ['lastMonth', 'Mes pasado'], ['year', 'Este año'], ['custom', 'Personalizado']];
  const accounts = uniq('account');
  return `<div class="filters">
    <select data-filter="range" aria-label="Periodo">${ranges.map(([v, l]) => opt(v, l, f.range)).join('')}</select>
    ${f.range === 'custom' ? `<input type="date" data-filter="from" value="${esc(f.from)}" aria-label="Desde">
      <input type="date" data-filter="to" value="${esc(f.to)}" aria-label="Hasta">` : ''}
    ${accounts.length > 1 ? `<select data-filter="account" aria-label="Cuenta">${opt('', 'Todas las cuentas', f.account)}${accounts.map((a) => opt(a, a, f.account)).join('')}</select>` : ''}
    <select data-filter="symbol" aria-label="Símbolo">${opt('', 'Todos los símbolos', f.symbol)}${uniq('root').map((a) => opt(a, a, f.symbol)).join('')}</select>
    <select data-filter="side" aria-label="Lado">${opt('', 'Largos y cortos', f.side)}${opt('long', 'Largos', f.side)}${opt('short', 'Cortos', f.side)}</select>
  </div>`;
}

// ---------- estructura ----------
const VIEWS = [
  ['panel', 'Panel'], ['operaciones', 'Operaciones'], ['diario', 'Diario'], ['reportes', 'Reportes'], ['importar', 'Importar'], ['ajustes', 'Ajustes'],
];
const LOGO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1c5cab"/><path d="M6 21l6-7 5 4 9-10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const view = () => { const v = location.hash.replace(/^#\/?/, '').split('/')[0]; return VIEWS.some(([k]) => k === v) ? v : 'panel'; };

function syncLine() {
  const s = S.state.sync;
  if (!s.configured) return 'Sincronización: sin configurar';
  if (s.lastError) return `Sincronización: error`;
  return `Sincronizado: ${s.lastOk ? fmtTime(s.lastOk) : 'pendiente'}`;
}

function render() {
  hideTip();
  const app = $('#app');
  if (S.needLogin) { app.innerHTML = loginView(); return; }
  if (!S.state) { app.innerHTML = '<div class="empty">Cargando…</div>'; return; }
  const v = view();
  const title = VIEWS.find(([k]) => k === v)[1];
  const showFilters = ['panel', 'operaciones', 'diario', 'reportes'].includes(v) && S.trades.length;
  app.innerHTML = `<div class="shell">
    <aside class="side">
      <div class="brand">${LOGO}<span>Diario de trading</span></div>
      <nav class="nav">${VIEWS.map(([k, l]) => `<a href="#${k}" ${k === v ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <div class="side-foot">${feat('sync') ? `<span>${esc(syncLine())}</span>` : ''}
        ${feat('theme') ? '<button class="btn small" data-action="theme">Cambiar tema</button>' : ''}
        ${S.state.passwordProtected ? '<button class="btn small" data-action="logout">Cerrar sesión</button>' : ''}</div>
    </aside>
    <main class="main">
      <div class="top"><h1>${title}</h1>${showFilters ? filterBar() : ''}</div>
      ${S.state.example ? '<div class="notice"><b>Datos de ejemplo.</b> Estas operaciones son inventadas para mostrar cómo funciona el diario. Desaparecen cuando <a href="#importar">importas tu CSV de Tradovate</a> o registras tu primera operación.</div>' : ''}
      ${S.state.storageNote ? `<div class="notice warn">${esc(S.state.storageNote)}</div>` : ''}
      <div id="view"></div>
    </main></div>
    <dialog class="drawer" id="drawer"></dialog>`;
  const el = $('#view');
  ({ panel: viewPanel, operaciones: viewTrades, diario: viewDiary, reportes: viewReports, importar: viewImport, ajustes: viewSettings })[v](el);
  if (S.openId) openDrawer(S.openId);
}

function loginView() {
  return `<div class="login"><form class="card" data-form="login">
    <div class="brand">${LOGO}<span>Diario de trading</span></div>
    <label class="field">Contraseña<input type="password" name="password" autocomplete="current-password" required autofocus></label>
    <button class="btn primary">Entrar</button></form></div>`;
}

const emptyState = () => `<div class="card empty"><strong>Todavía no hay operaciones</strong>
  Importa el reporte de Tradovate o registra una operación manual para ver tus métricas.
  <div style="margin-top:14px"><a class="btn primary" href="#importar" style="text-decoration:none">Importar operaciones</a></div></div>`;
const noMatch = () => '<div class="card empty"><strong>Sin operaciones en este filtro</strong>Cambia el periodo o los filtros para ver resultados.</div>';

// ---------- panel ----------
function kpi(label, value, sub = '', extra = '') {
  return `<div class="card kpi"><div class="label">${label}</div><div class="value num">${value}</div>${sub ? `<div class="sub num">${sub}</div>` : ''}${extra}</div>`;
}
function viewPanel(el) {
  if (!S.trades.length) { el.innerHTML = emptyState(); return; }
  const list = filtered();
  const s = summarize(list);
  const open = list.filter((t) => t.status === 'open').length;
  if (!s.count) { el.innerHTML = noMatch() + calendarCard(); return; }
  const ratio = s.avgWin != null && s.avgLoss ? s.avgWin / -s.avgLoss : null;
  const winMeter = s.winRate == null ? '' : `<div class="meter"><i style="width:${s.winRate * 100}%"></i><b></b></div>`;
  const unknown = [...new Set(list.filter((t) => t.unknownInstrument).map((t) => t.root))];
  el.innerHTML = `
    ${unknown.length ? `<div class="notice warn">No conozco el valor por punto de <b>${esc(unknown.join(', '))}</b>; su resultado se calcula con valor 1. Corrígelo en <a href="#ajustes">Ajustes</a>.</div>` : ''}
    ${open ? `<div class="notice">${open} posición(es) abierta(s) no se incluyen en las métricas hasta que se cierren.</div>` : ''}
    <div class="grid kpis">
      ${kpi('Resultado neto', `<span class="${cls(s.net)}">${money(s.net)}</span>`, `${s.count} operaciones · comisiones ${money(-s.fees, { sign: false })}`)}
      ${kpi('Tasa de acierto', pct(s.winRate), `${s.wins} ganadoras · ${s.losses} perdedoras${s.breakeven ? ` · ${s.breakeven} en cero` : ''}`, winMeter)}
      ${kpi('Factor de beneficio', s.profitFactor == null ? (s.wins ? '∞' : '—') : num(s.profitFactor), 'ganancias ÷ pérdidas')}
      ${kpi('Expectativa', `<span class="${cls(s.expectancy)}">${money(s.expectancy)}</span>`, 'promedio por operación')}
      ${kpi('Ganancia / pérdida media', ratio == null ? '—' : num(ratio), `${money(s.avgWin)} / ${money(s.avgLoss)}`)}
      ${kpi('Drawdown máximo', money(-s.maxDrawdown, { sign: false }), `días ganadores ${pct(s.dayWinRate)}`)}
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card"><h2>Curva de capital <small>resultado neto acumulado por día</small></h2><div class="chart" id="c-equity"></div></div>
      <div class="card"><h2>Resultado por día <small>${s.tradingDays} días operados</small></h2><div class="chart" id="c-daily"></div></div>
    </div>
    <div class="grid two" style="margin-top:14px">${calendarCard()}
      <div class="card"><h2>Detalle</h2><table class="kv"><tbody>
        ${[['Mayor ganancia', money(s.largestWin)], ['Mayor pérdida', money(s.largestLoss)],
    ['Mejor día', s.bestDay ? `${money(s.bestDay.net)} · ${fmtDay(s.bestDay.day)}` : '—'],
    ['Peor día', s.worstDay ? `${money(s.worstDay.net)} · ${fmtDay(s.worstDay.day)}` : '—'],
    ['Racha ganadora / perdedora', `${s.maxWinStreak} / ${s.maxLossStreak}`],
    ['Duración media', duration(s.avgDuration)],
    ['Duración ganadoras / perdedoras', `${duration(s.avgWinDuration)} / ${duration(s.avgLossDuration)}`],
    ['Contratos operados', num(s.contracts, 0)],
    ['R medio', s.avgR == null ? 'sin stops registrados' : `${num(s.avgR)} R (${s.rCount} op.)`],
    ['Resultado bruto', money(s.gross)]].map(([a, b]) => `<tr><td class="muted">${a}</td><td class="r num">${b}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  const dayTip = (d) => `<b class="num">${money(d.net)}</b>${fmtDayLong(d.day)}<br>${d.count} operación(es) · acumulado ${money(d.cum)}`;
  lineChart($('#c-equity'), s.days.map((d) => ({ label: fmtDay(d.day), value: d.cum, tip: `<b class="num">${money(d.cum)}</b>${fmtDayLong(d.day)}<br>día: ${money(d.net)}` })));
  columnChart($('#c-daily'), s.days.map((d) => ({ label: fmtDay(d.day), value: d.net, tip: dayTip(d) })));
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shortMoney = (v) => {
  const a = Math.abs(v);
  const body = a >= 10000 ? `${Math.round(a / 1000)}K` : a >= 1000 ? `${(a / 1000).toFixed(1)}K` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : v > 0 ? '+' : ''}$${body}`;
};
const calPnl = (v) => `<span class="pnl num"><span class="full">${money(v)}</span><span class="short">${shortMoney(v)}</span></span>`;
function calendarCard() {
  const days = new Map(summarize(filtered({ ignoreRange: true })).days.map((d) => [d.day, d]));
  if (!S.calMonth) {
    const last = [...days.keys()].pop();
    S.calMonth = (last || today()).slice(0, 7);
  }
  const first = `${S.calMonth}-01`;
  const start = addDays(first, -((weekday(first) + 6) % 7));
  const t = today();
  let monthNet = 0, monthDays = 0;
  let cells = '';
  for (let w = 0; w < 6; w++) {
    let weekNet = 0, weekN = 0, row = '';
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, w * 7 + i);
      const inMonth = day.startsWith(S.calMonth);
      const d = inMonth ? days.get(day) : null;
      if (d) { weekNet += d.net; weekN += d.count; monthNet += d.net; monthDays++; }
      const c = ['cell', !inMonth && 'out', d && (d.net > 0 ? 'win' : d.net < 0 ? 'loss' : ''), day === t && 'today'].filter(Boolean).join(' ');
      row += !inMonth ? `<div class="${c}"></div>` : d
        ? `<button class="${c}" data-action="go-day" data-day="${day}" title="${fmtDayLong(day)}"><span class="d">${+day.slice(8)}</span>${calPnl(d.net)}<span class="n">${d.count} op.</span></button>`
        : `<div class="${c}"><span class="d">${+day.slice(8)}</span></div>`;
    }
    if (w === 5 && !addDays(start, 35).startsWith(S.calMonth)) break;
    cells += `${row}<div class="cell week"><span class="d">Semana ${w + 1}</span>${weekN ? `${calPnl(weekNet)}<span class="n">${weekN} op.</span>` : ''}</div>`;
  }
  return `<div class="card"><div class="cal-head"><h2>${cap(fmtDay(first, { month: 'long', year: 'numeric' }))}</h2>
      <span class="num ${cls(monthNet)}" style="font-weight:650">${monthDays ? money(monthNet) : ''}</span>
      <button class="btn small" data-action="cal" data-step="-1" aria-label="Mes anterior">‹</button>
      <button class="btn small" data-action="cal" data-step="1" aria-label="Mes siguiente">›</button></div>
    <div class="cal">${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => `<div class="dow">${d}</div>`).join('')}<div class="dow wk">Total</div>${cells}</div></div>`;
}

// ---------- operaciones ----------
const COLS = [
  ['time', 'Fecha', (t) => t.exitTs || t.entryTs], ['contract', 'Contrato', (t) => t.contract], ['side', 'Lado', (t) => t.side],
  ['qty', 'Cant.', (t) => t.qty, 'r'], ['entry', 'Entrada', (t) => t.entryPrice, 'r'], ['exit', 'Salida', (t) => t.exitPrice ?? 0, 'r'],
  ['dur', 'Duración', (t) => t.durationS ?? 0, 'r'], ['net', 'Neto', (t) => t.net, 'r'], ['r', 'R', (t) => rMultiple(t) ?? -Infinity, 'r'],
  ['strategy', 'Estrategia', (t) => t.strategy.toLowerCase()],
];
const PAGE = 100;
function tradeRows(list) {
  return list.map((t) => {
    const r = rMultiple(t);
    return `<tr class="click" data-action="open" data-id="${esc(t.id)}" tabindex="0">
      <td class="num">${fmtTime(t.exitTs || t.entryTs)}</td><td>${esc(t.contract)}</td>
      <td><span class="pill ${t.side}">${t.side === 'long' ? 'Largo' : 'Corto'}</span>${t.status === 'open' ? ' <span class="pill open">Abierta</span>' : ''}</td>
      <td class="r num">${num(t.qty, 0)}</td><td class="r num">${price(t.entryPrice)}</td><td class="r num">${price(t.exitPrice)}</td>
      <td class="r num">${duration(t.durationS)}</td>
      <td class="r num ${cls(t.net)}"><b>${t.status === 'open' ? '—' : money(t.net)}</b></td>
      <td class="r num">${r == null ? '—' : `${num(r)} R`}</td>
      <td>${t.strategy ? `<span class="pill">${esc(t.strategy)}</span>` : ''} ${t.tags.map((x) => `<span class="pill">${esc(x)}</span>`).join(' ')}${t.notes ? ' <span class="muted" title="Tiene notas">✎</span>' : ''}</td></tr>`;
  }).join('');
}
function viewTrades(el) {
  if (!S.trades.length) { el.innerHTML = emptyState(); return; }
  const col = COLS.find((c) => c[0] === S.sort.key);
  const list = filtered().sort((a, b) => { const x = col[2](a), y = col[2](b); return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir; });
  if (!list.length) { el.innerHTML = noMatch(); return; }
  const s = summarize(list);
  const shown = list.slice(0, S.page * PAGE);
  el.innerHTML = `<div class="card">
    <h2>${list.length} operaciones <small class="num">neto <b class="${cls(s.net)}">${money(s.net)}</b></small></h2>
    <div class="table-wrap"><table><thead><tr>${COLS.map(([k, l, , c]) => `<th class="${c || ''}" aria-sort="${S.sort.key === k ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-action="sort" data-key="${k}">${l}${S.sort.key === k ? (S.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`).join('')}</tr></thead>
    <tbody>${tradeRows(shown)}</tbody></table></div>
    ${shown.length < list.length ? `<div style="text-align:center;margin-top:12px"><button class="btn" data-action="more">Mostrar más (${list.length - shown.length} restantes)</button></div>` : ''}</div>`;
}

// ---------- detalle de una operación ----------
function openDrawer(id) {
  const t = S.trades.find((x) => x.id === id);
  const dlg = $('#drawer');
  if (!t || !dlg) { S.openId = null; return; }
  S.openId = id;
  const r = rMultiple(t);
  const sign = t.side === 'long' ? 1 : -1;
  const pts = t.exitPrice == null ? null : sign * (t.exitPrice - t.entryPrice);
  const strategies = [...new Set(S.trades.map((x) => x.strategy).filter(Boolean))].sort();
  dlg.innerHTML = `<div class="drawer-body">
    <div class="drawer-head"><h1>${esc(t.contract)} <span class="pill ${t.side}">${t.side === 'long' ? 'Largo' : 'Corto'}</span></h1>
      <button class="btn" data-action="close">Cerrar</button></div>
    <div class="stat-row">
      <div><span>Neto</span><b class="num ${cls(t.net)}">${t.status === 'open' ? 'Abierta' : money(t.net)}</b></div>
      <div><span>Bruto</span><b class="num">${money(t.gross)}</b></div>
      <div><span>Comisiones</span><b class="num">${money(-t.fees, { sign: false })}</b></div>
      <div><span>Puntos</span><b class="num">${pts == null ? '—' : num(pts)}</b></div>
      <div><span>R múltiple</span><b class="num">${r == null ? '—' : `${num(r)} R`}</b></div>
      <div><span>Duración</span><b class="num">${duration(t.durationS)}</b></div>
    </div>
    <div class="muted">Cuenta ${esc(t.account)} · ${num(t.qty, 0)} contrato(s) · valor por punto ${price(t.mult)} · ${fmtDayLong(t.day)}</div>
    <div class="form-grid">
      <label class="field">Estrategia<input type="text" data-meta="strategy" value="${esc(t.strategy)}" list="dl-strategies" placeholder="p. ej. Ruptura de apertura">
        <datalist id="dl-strategies">${strategies.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
      <label class="field">Precio del stop<input type="number" step="any" data-meta="stop" value="${t.stop ?? ''}" placeholder="para calcular R"></label>
      <label class="field">Etiquetas<input type="text" data-meta="tags" value="${esc(t.tags.join(', '))}" placeholder="separadas por comas"></label>
      <label class="field">Errores<input type="text" data-meta="mistakes" value="${esc(t.mistakes.join(', '))}" placeholder="p. ej. entrada tardía, sin plan"></label>
    </div>
    <label class="field">Notas<textarea data-meta="notes" placeholder="¿Qué viste? ¿Qué hiciste bien o mal?">${esc(t.notes)}</textarea></label>
    <div ${feat('shots') ? '' : 'hidden'}><h3 style="margin-bottom:8px">Capturas</h3>
      <div class="shots">${t.shots.map((s) => `<div class="shot"><a href="/uploads/${esc(s)}" target="_blank" rel="noopener"><img src="/uploads/${esc(s)}" alt="Captura de la operación" loading="lazy"></a>
        <button class="btn small" data-action="del-shot" data-shot="${esc(s)}" aria-label="Quitar captura">✕</button></div>`).join('')}</div>
      <label class="drop" style="margin-top:8px;padding:14px">Añadir captura (o pégala con Ctrl+V)<input type="file" accept="image/png,image/jpeg,image/webp" data-upload="shot" multiple></label></div>
    <div><h3 style="margin-bottom:8px">Ejecuciones</h3><div class="table-wrap"><table><thead><tr><th>Hora</th><th>Lado</th><th class="r">Cant.</th><th class="r">Precio</th></tr></thead>
      <tbody>${t.legs.map((l) => `<tr><td class="num">${fmtTime(l.ts)}</td><td>${l.side === 'B' ? 'Compra' : 'Venta'} <span class="muted">${l.role === 'in' ? 'entrada' : 'salida'}</span></td><td class="r num">${num(l.qty, 0)}</td><td class="r num">${price(l.price)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="row"><button class="btn danger" data-action="del-trade">Eliminar operación</button></div></div>`;
  if (!dlg.open) dlg.showModal();
}
async function saveMeta(field, value) {
  const patch = {};
  if (field === 'tags' || field === 'mistakes') patch[field] = value.split(',').map((s) => s.trim()).filter(Boolean);
  else if (field === 'stop') patch.stop = value === '' ? null : Number(value);
  else patch[field] = value;
  const updated = await api('PUT', `/api/trades/${encodeURIComponent(S.openId)}/meta`, patch);
  S.trades = S.trades.map((t) => (t.id === updated.id ? updated : t));
  if (field === 'stop') openDrawer(S.openId);
}
function readFile(file, as) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    as === 'text' ? r.readAsText(file) : r.readAsDataURL(file);
  });
}
async function addShots(files) {
  for (const f of files) {
    if (f.size > 12 * 1024 * 1024) { toast('La imagen supera 12 MB.'); continue; }
    const updated = await api('POST', `/api/trades/${encodeURIComponent(S.openId)}/shots`, { dataUrl: await readFile(f, 'url') });
    S.trades = S.trades.map((t) => (t.id === updated.id ? updated : t));
  }
  openDrawer(S.openId);
}

// ---------- diario ----------
function viewDiary(el) {
  if (!S.trades.length) { el.innerHTML = emptyState(); return; }
  const list = filtered().filter((t) => t.status === 'closed');
  const byDay = new Map();
  for (const t of list) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t); }
  const [from, to] = rangeBounds();
  for (const day of Object.keys(S.state.days)) if (!byDay.has(day) && day >= from && day <= to) byDay.set(day, []);
  const days = [...byDay.keys()].sort().reverse();
  if (!days.length) { el.innerHTML = noMatch(); return; }
  el.innerHTML = `<div class="stack">${days.slice(0, 60).map((day) => {
    const ts = byDay.get(day).sort((a, b) => (a.exitTs < b.exitTs ? -1 : 1));
    const s = summarize(ts);
    return `<section class="card day-card" id="dia-${day}"><header><h2>${cap(fmtDayLong(day))}</h2>
      ${s.count ? `<b class="num ${cls(s.net)}">${money(s.net)}</b><span class="muted num">${s.count} op. · acierto ${pct(s.winRate)} · factor ${s.profitFactor == null ? '—' : num(s.profitFactor)}</span>` : '<span class="muted">Sin operaciones</span>'}</header>
      <label class="field">Notas del día<textarea data-day="${day}" placeholder="Plan, contexto de mercado, estado de ánimo, lecciones…">${esc(S.state.days[day] || '')}</textarea></label>
      ${s.count ? `<div class="table-wrap" style="margin-top:10px"><table><tbody>${ts.map((t) => `<tr class="click" data-action="open" data-id="${esc(t.id)}" tabindex="0">
        <td class="num">${fmtTime(t.entryTs, false)}</td><td>${esc(t.contract)}</td><td><span class="pill ${t.side}">${t.side === 'long' ? 'Largo' : 'Corto'}</span></td>
        <td class="r num">${num(t.qty, 0)}</td><td class="r num">${duration(t.durationS)}</td><td class="r num ${cls(t.net)}"><b>${money(t.net)}</b></td>
        <td>${t.strategy ? `<span class="pill">${esc(t.strategy)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}</section>`;
  }).join('')}${days.length > 60 ? '<div class="muted" style="text-align:center">Se muestran los 60 días más recientes del filtro.</div>' : ''}</div>`;
}

// ---------- reportes ----------
const REPORTS = {
  symbol: ['Símbolo', (t) => t.root],
  dow: ['Día de la semana', (t) => weekday(t.day), (k) => DOW[k], (a, b) => ((a.key + 6) % 7) - ((b.key + 6) % 7)],
  hour: ['Hora de entrada', (t) => t.hour, (k) => `${String(k).padStart(2, '0')}:00`, (a, b) => a.key - b.key],
  duration: ['Duración', durationBucket, null, (a, b) => DURATION_BUCKETS.findIndex(([n]) => n === a.key) - DURATION_BUCKETS.findIndex(([n]) => n === b.key)],
  side: ['Lado', (t) => (t.side === 'long' ? 'Largos' : 'Cortos')],
  strategy: ['Estrategia', (t) => t.strategy || 'Sin estrategia'],
  tag: ['Etiqueta', (t) => (t.tags.length ? t.tags : ['Sin etiqueta'])],
  mistake: ['Error', (t) => (t.mistakes.length ? t.mistakes : ['Sin errores'])],
};
function viewReports(el) {
  if (!S.trades.length) { el.innerHTML = emptyState(); return; }
  const list = filtered();
  const [title, keyFn, labelFn, sortFn] = REPORTS[S.reportTab];
  const groups = groupStats(list, keyFn).sort(sortFn || ((a, b) => b.net - a.net));
  const label = (g) => (labelFn ? labelFn(g.key) : String(g.key));
  const tabs = `<div class="tabs" role="tablist">${Object.entries(REPORTS).map(([k, [l]]) => `<button role="tab" aria-selected="${k === S.reportTab}" data-action="report" data-tab="${k}">${l}</button>`).join('')}</div>`;
  if (!groups.length) { el.innerHTML = tabs + noMatch(); return; }
  el.innerHTML = `${tabs}<div class="grid half">
    <div class="card"><h2>Resultado neto por ${title.toLowerCase()}</h2><div id="c-report"></div></div>
    <div class="card"><h2>${title}</h2><div class="table-wrap"><table><thead><tr><th>${title}</th><th class="r">Op.</th><th class="r">Neto</th><th class="r">Acierto</th><th class="r">Factor</th><th class="r">Expectativa</th></tr></thead>
      <tbody>${groups.map((g) => `<tr><td>${esc(label(g))}</td><td class="r num">${g.count}</td><td class="r num ${cls(g.net)}"><b>${money(g.net)}</b></td>
        <td class="r num">${pct(g.winRate)}</td><td class="r num">${g.profitFactor == null ? '—' : num(g.profitFactor)}</td><td class="r num">${money(g.expectancy)}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  hbarChart($('#c-report'), groups.map((g) => ({
    label: label(g), value: g.net, text: money(g.net),
    tip: `<b class="num">${money(g.net)}</b>${esc(label(g))}<br>${g.count} operación(es) · acierto ${pct(g.winRate)}`,
  })));
}

// ---------- importar ----------
function syncCard() {
  const s = S.state.sync;
  if (!feat('sync')) {
    return `<div class="card"><h2>Sincronización automática con Tradovate</h2>
      <p class="muted" style="margin:0">No está disponible en esta página: conectarse a la API de Tradovate requiere la versión con servidor propio. Aquí las operaciones entran por CSV o a mano.</p></div>`;
  }
  if (!s.configured) {
    return `<div class="card"><h2>Sincronización automática con Tradovate</h2>
      <p class="muted" style="margin-top:0">Sin configurar. Cuando actives el complemento <b>API Access</b> en tu cuenta de Tradovate:</p>
      <ol class="steps"><li>En Tradovate, genera una clave de API (obtendrás un <code>cid</code> y un <code>secret</code>).</li>
      <li>Copia <code>.env.example</code> a <code>.env</code> en el servidor y completa los datos de Tradovate.</li>
      <li>Reinicia la app. A partir de ahí descargará tus ejecuciones sola cada pocos minutos.</li></ol></div>`;
  }
  return `<div class="card"><h2>Sincronización automática con Tradovate <small>entorno ${s.env === 'live' ? 'real' : 'demo'}</small></h2>
    ${s.lastError ? `<div class="notice warn">Último intento con error: ${esc(s.lastError)}</div>` : ''}
    <div class="row"><button class="btn primary" data-action="sync">Sincronizar ahora</button>
      <span class="muted">${s.lastOk ? `Última sincronización correcta: ${fmtTime(s.lastOk)} · ${s.lastAdded} ejecución(es) nueva(s)` : 'Aún no se ha completado ninguna sincronización.'}</span></div></div>`;
}
function viewImport(el) {
  const accounts = uniq('account');
  el.innerHTML = `<div class="stack">
    <div class="card"><h2>Importar desde Tradovate (CSV)</h2>
      <ol class="steps" style="margin-bottom:12px"><li>En Tradovate abre <b>Account → Reports</b> (o la pestaña <b>Performance</b>).</li>
        <li>Elige el rango de fechas y descarga el reporte <b>Performance</b> o <b>Fills</b> en CSV.</li>
        <li>Súbelo aquí. Puedes repetir la importación: las ejecuciones ya cargadas no se duplican.</li></ol>
      <div class="form-grid" style="margin-bottom:12px"><label class="field">Nombre de la cuenta<input type="text" id="imp-account" value="${esc(accounts[0] || 'Tradovate')}"></label></div>
      <label class="drop" id="drop">Arrastra el archivo CSV aquí o haz clic para elegirlo<input type="file" accept=".csv,text/csv" data-upload="csv" multiple></label>
      <p class="muted" style="margin-bottom:0">Las horas del archivo se interpretan en la zona horaria <b>${esc(tz())}</b> (cámbiala en Ajustes si no coincide con la de tu Tradovate).</p></div>
    ${syncCard()}
    <div class="card"><h2>Registrar una operación manual</h2>
      <form data-form="manual" class="stack"><div class="form-grid">
        <label class="field">Contrato<input name="contract" type="text" placeholder="MNQZ6" required></label>
        <label class="field">Lado<select name="side"><option value="long">Largo</option><option value="short">Corto</option></select></label>
        <label class="field">Cantidad<input name="qty" type="number" min="1" step="1" value="1" required></label>
        <label class="field">Precio de entrada<input name="entryPrice" type="number" step="any" required></label>
        <label class="field">Precio de salida<input name="exitPrice" type="number" step="any" required></label>
        <label class="field">Entrada<input name="entryTime" type="datetime-local" step="1" required></label>
        <label class="field">Salida<input name="exitTime" type="datetime-local" step="1" required></label>
        <label class="field">Comisiones totales ($)<input name="fees" type="number" min="0" step="any" placeholder="según Ajustes"></label>
        <label class="field">Cuenta<input name="account" type="text" value="${esc(accounts[0] || 'Tradovate')}"></label>
      </div><div><button class="btn primary">Guardar operación</button></div></form></div></div>`;
}
async function importFiles(files) {
  const account = $('#imp-account')?.value || 'Tradovate';
  for (const f of files) {
    try {
      const r = await api('POST', '/api/import', { csv: await readFile(f, 'text'), account });
      const extra = [...r.warnings, r.newInstruments.length ? `Instrumentos nuevos: ${r.newInstruments.join(', ')}.` : '',
        r.unknown.length ? `Revisa el valor por punto de ${r.unknown.join(', ')} en Ajustes.` : ''].filter(Boolean).join(' ');
      toast(`${f.name}: ${r.added} ejecución(es) nueva(s), ${r.duplicates} repetida(s). ${extra}`);
    } catch (e) { toast(`${f.name}: ${e.message}`); }
  }
  S.calMonth = null;
  await reload();
}

// ---------- ajustes ----------
function viewSettings(el) {
  const used = new Set(S.trades.map((t) => t.root));
  const inst = [...S.state.instruments].sort((a, b) => (used.has(b.root) - used.has(a.root)) || a.root.localeCompare(b.root));
  const zones = [...new Set([tz(), 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Caracas', 'Europe/Madrid', 'Europe/London', 'UTC'])];
  el.innerHTML = `<div class="stack">
    <div class="card"><h2>Zona horaria</h2><div class="row"><select id="set-tz">${zones.map((z) => `<option ${z === tz() ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
      <span class="muted">Define a qué día pertenece cada operación y cómo se leen las horas de los CSV.</span></div></div>
    <div class="card"><h2>Instrumentos y comisiones <small>la comisión es por contrato y por lado</small></h2>
      <p class="muted" style="margin-top:0">El reporte Performance de Tradovate no trae comisiones: indícalas aquí para que el resultado neto sea real. Con la sincronización por API se usan las comisiones exactas de cada ejecución.</p>
      <div class="table-wrap"><table><thead><tr><th>Símbolo</th><th>Nombre</th><th class="r">Valor por punto ($)</th><th class="r">Comisión ($)</th><th></th></tr></thead>
      <tbody>${inst.map((i) => `<tr data-root="${esc(i.root)}"><td><b>${esc(i.root)}</b>${used.has(i.root) ? ' <span class="pill open">en uso</span>' : ''}</td><td class="muted">${esc(i.name)}</td>
        <td class="r"><input type="number" step="any" min="0" value="${i.multiplier}" data-inst="multiplier" style="width:110px;text-align:right" aria-label="Valor por punto de ${esc(i.root)}"></td>
        <td class="r"><input type="number" step="any" min="0" value="${i.fee}" data-inst="fee" style="width:90px;text-align:right" aria-label="Comisión de ${esc(i.root)}"></td>
        <td><button class="btn small" data-action="save-inst">Guardar</button></td></tr>`).join('')}
        <tr data-root=""><td><input type="text" placeholder="Nuevo símbolo" data-inst="root" style="width:120px" aria-label="Nuevo símbolo"></td><td></td>
        <td class="r"><input type="number" step="any" min="0" data-inst="multiplier" style="width:110px;text-align:right" aria-label="Valor por punto"></td>
        <td class="r"><input type="number" step="any" min="0" value="0" data-inst="fee" style="width:90px;text-align:right" aria-label="Comisión"></td>
        <td><button class="btn small" data-action="save-inst">Añadir</button></td></tr></tbody></table></div></div>
    <div class="card"><h2>Datos</h2><p class="muted" style="margin:0">${S.state.dataNote ? esc(S.state.dataNote) : `${S.state.fills} ejecuciones guardadas en <code>data/diario.db</code> (SQLite) y capturas en <code>data/uploads</code>. Haz copia de la carpeta <code>data</code> para respaldar todo.`}</p></div></div>`;
}

// ---------- eventos ----------
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!S.needLogin) toast(e.message); } };

document.addEventListener('click', guard(async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'open') { openDrawer(el.dataset.id); }
  else if (a === 'close') { $('#drawer').close(); }
  else if (a === 'sort') { S.sort = { key: el.dataset.key, dir: S.sort.key === el.dataset.key ? -S.sort.dir : -1 }; render(); }
  else if (a === 'more') { S.page++; render(); }
  else if (a === 'report') { S.reportTab = el.dataset.tab; render(); }
  else if (a === 'cal') {
    const [y, m] = S.calMonth.split('-').map(Number);
    S.calMonth = new Date(Date.UTC(y, m - 1 + Number(el.dataset.step), 1)).toISOString().slice(0, 7);
    render();
  } else if (a === 'go-day') {
    S.filter = { ...S.filter, range: 'custom', from: el.dataset.day, to: el.dataset.day };
    location.hash = "#diario";
  } else if (a === 'theme') {
    const next = (document.documentElement.dataset.theme || 'dark') === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('tema', next); } catch { /* sin almacenamiento */ }
  } else if (a === 'logout') { await api('POST', '/api/logout'); S.needLogin = true; render(); }
  else if (a === 'sync') {
    el.disabled = true; el.textContent = 'Sincronizando…';
    try { const r = await api('POST', '/api/sync'); toast(`Sincronización completa: ${r.added} ejecución(es) nueva(s).`); }
    finally { await reload(); }
  } else if (a === 'del-trade') {
    if (!el.dataset.armed) {
      el.dataset.armed = '1'; el.textContent = 'Confirmar: eliminar definitivamente';
      setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Eliminar operación'; } }, 5000);
      return;
    }
    await api('DELETE', `/api/trades/${encodeURIComponent(S.openId)}`);
    S.openId = null; toast('Operación eliminada.'); await reload();
  } else if (a === 'del-shot') {
    const updated = await api('DELETE', `/api/trades/${encodeURIComponent(S.openId)}/shots/${encodeURIComponent(el.dataset.shot)}`);
    S.trades = S.trades.map((t) => (t.id === updated.id ? updated : t)); openDrawer(S.openId);
  } else if (a === 'save-inst') {
    const row = el.closest('tr');
    const root = row.dataset.root || $('[data-inst=root]', row).value;
    S.state = await api('PUT', `/api/instruments/${encodeURIComponent(root.trim().toUpperCase())}`, {
      multiplier: $('[data-inst=multiplier]', row).value, fee: $('[data-inst=fee]', row).value,
    });
    S.trades = await api('GET', '/api/trades');
    toast(`${root.toUpperCase()} guardado. Los resultados se recalcularon.`); render();
  }
}));

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches?.('tr[data-action=open]')) openDrawer(ev.target.dataset.id);
});

document.addEventListener('change', guard(async (ev) => {
  const el = ev.target;
  if (el.dataset.filter) { S.filter[el.dataset.filter] = el.value; S.page = 1; render(); }
  else if (el.dataset.meta) { await saveMeta(el.dataset.meta, el.value); }
  else if (el.dataset.day) { await api('PUT', `/api/days/${el.dataset.day}`, { notes: el.value }); S.state.days[el.dataset.day] = el.value; toast('Notas guardadas.'); }
  else if (el.dataset.upload === 'csv') { await importFiles([...el.files]); }
  else if (el.dataset.upload === 'shot') { await addShots([...el.files]); }
  else if (el.id === 'set-tz') { S.state = await api('PUT', '/api/settings', { tz: el.value }); S.trades = await api('GET', '/api/trades'); S.calMonth = null; toast('Zona horaria actualizada.'); render(); }
}));

document.addEventListener('submit', guard(async (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.form === 'login') {
    try { await api('POST', '/api/login', data); } catch (e) { toast(e.message); return; }
    await reload();
  } else if (form.dataset.form === 'manual') {
    await api('POST', '/api/trades', data);
    toast('Operación guardada.'); S.calMonth = null; await reload();
  }
}));

document.addEventListener('paste', guard(async (ev) => {
  if (!S.openId || !$('#drawer')?.open) return;
  const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { ev.preventDefault(); await addShots(files); }
}));
document.addEventListener('close', (ev) => { if (ev.target.id === 'drawer') { S.openId = null; if (['operaciones', 'diario'].includes(view())) render(); } }, true);
document.addEventListener('click', (ev) => { if (ev.target.id === 'drawer') ev.target.close(); });
for (const type of ['dragover', 'dragleave', 'drop']) {
  document.addEventListener(type, guard(async (ev) => {
    const drop = ev.target.closest?.('#drop');
    if (!drop) return;
    ev.preventDefault();
    drop.classList.toggle('over', type === 'dragover');
    if (type === 'drop') await importFiles([...ev.dataTransfer.files]);
  }));
}
window.addEventListener('hashchange', () => { S.page = 1; S.openId = null; render(); scrollTo(0, 0); });

render();
load().then(render).catch((e) => { if (!S.needLogin) $('#app').innerHTML = `<div class="empty">No se pudo cargar: ${esc(e.message)}</div>`; });
