import { summarize, groupStats, rMultiple, durationBucket, DURATION_BUCKETS, weekday, heatmap } from '/lib/stats.js';
import { evaluateRules, behavioralInsights, normalizeRules, RULE_LABELS, KIND_LABELS } from '/lib/insights.js';
import { normalizePlaybooks, playbookTemplate, playbookStats, flatRules } from '/lib/playbooks.js';
import { newsDayStats, positionSize } from '/lib/news.js';
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
  pbSel: null, pbDraft: null, pbNew: false, sel: new Set(),
  news: { weekStart: null, impacts: ['high', 'medium'], country: null, cache: new Map(), enabled: false },
  ai: { messages: [], busy: false, market: false, journal: false, status: '', ctl: null, available: null },
};
const uid = () => (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 12);
const pbOf = (id) => S.state.settings.playbooks.find((p) => p.id === id);
const tz = () => S.state.settings.tz;
const fmtTime = (ts, withDate = true) => (ts ? new Date(ts).toLocaleString('es', {
  timeZone: tz(), ...(withDate ? { day: '2-digit', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}) : '—');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date());

const currentTheme = () => (getComputedStyle(document.documentElement).colorScheme.includes('light') ? 'light' : 'dark');

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
  const ids = new Set(S.trades.map((t) => t.id));
  for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
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
  ['panel', 'Panel'], ['operaciones', 'Operaciones'], ['diario', 'Diario'], ['playbooks', 'Playbooks'], ['disciplina', 'Disciplina'], ['reportes', 'Reportes'], ['noticias', 'Noticias'], ['asistente', 'Asistente'], ['importar', 'Importar'], ['ajustes', 'Ajustes'],
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
  const showFilters = ['panel', 'operaciones', 'diario', 'playbooks', 'disciplina', 'reportes'].includes(v) && S.trades.length;
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
      ${S.state.storageNote ? `<div class="notice warn">${esc(S.state.storageNote)}</div>` : ''}
      <div id="view"></div>
    </main></div>
    <dialog class="drawer" id="drawer"></dialog>`;
  const el = $('#view');
  ({ panel: viewPanel, operaciones: viewTrades, diario: viewDiary, playbooks: viewPlaybooks, disciplina: viewDiscipline, reportes: viewReports, noticias: viewNews, asistente: viewAssistant, importar: viewImport, ajustes: viewSettings })[v](el);
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
  const noFees = [...new Set(list.filter((t) => t.status === 'closed' && t.fees === 0).map((t) => t.root))];
  el.innerHTML = `
    ${noFees.length ? `<div class="notice warn">Estas operaciones no descuentan comisiones (${esc(noFees.join(', '))}): su resultado neto es igual al bruto. Indica la comisión por contrato en <a href="#ajustes">Ajustes</a> y se recalcula todo.</div>` : ''}
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
      <td><input type="checkbox" data-sel="${esc(t.id)}" ${S.sel.has(t.id) ? 'checked' : ''} aria-label="Seleccionar operación"></td>
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
  const n = S.sel.size, allShown = shown.length > 0 && shown.every((t) => S.sel.has(t.id));
  const bar = `<div class="row" style="margin-bottom:10px"><span class="muted">${n ? `${n} seleccionada${n === 1 ? '' : 's'}` : 'Marca casillas para borrar varias a la vez'}</span>
    <button class="btn small" data-action="sel-filtered">Seleccionar las ${list.length} del filtro</button>
    ${n ? '<button class="btn small" data-action="sel-clear">Quitar selección</button><button class="btn small danger" data-action="del-selected">Eliminar seleccionadas</button>' : ''}</div>`;
  el.innerHTML = `<div class="card">
    <h2>${list.length} operaciones <small class="num">neto <b class="${cls(s.net)}">${money(s.net)}</b></small></h2>
    ${bar}
    <div class="table-wrap"><table><thead><tr><th><input type="checkbox" data-sel-all ${allShown ? 'checked' : ''} aria-label="Seleccionar las operaciones visibles"></th>${COLS.map(([k, l, , c]) => `<th class="${c || ''}" aria-sort="${S.sort.key === k ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-action="sort" data-key="${k}">${l}${S.sort.key === k ? (S.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`).join('')}</tr></thead>
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
    ${playbookBlock(t)}
    <div class="form-grid">
      <label class="field">Estrategia (nota libre)<input type="text" data-meta="strategy" value="${esc(t.strategy)}" list="dl-strategies" placeholder="p. ej. Ruptura de apertura">
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
function playbookBlock(t) {
  const pbs = S.state.settings.playbooks;
  const pb = pbs.find((p) => p.id === t.playbook);
  const rules = pb ? flatRules(pb) : [];
  const done = new Set(t.followed);
  const n = rules.filter((r) => done.has(r.id)).length;
  return `<div class="stack" style="gap:10px"><label class="field">Playbook<select data-meta="playbook">
      <option value="">Sin playbook</option>${pbs.map((p) => `<option value="${esc(p.id)}" ${p.id === t.playbook ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    ${pbs.length ? '' : '<p class="muted" style="margin:0">Crea tu primer playbook en la sección <a href="#playbooks">Playbooks</a> para marcar qué reglas cumpliste en cada operación.</p>'}
    ${pb ? `<div class="card" style="background:var(--surface-2)"><h3 style="margin-bottom:8px">Reglas cumplidas <span class="num">${n}/${rules.length}</span></h3>
      ${pb.groups.map((g) => g.rules.length ? `<div style="margin-bottom:8px"><div class="muted" style="font-size:12px;margin-bottom:4px">${esc(g.name)}</div>
        ${g.rules.map((r) => `<label class="row" style="flex-wrap:nowrap;align-items:flex-start;margin-bottom:4px"><input type="checkbox" data-follow value="${esc(r.id)}" ${done.has(r.id) ? 'checked' : ''}> <span>${esc(r.text)}</span></label>`).join('')}</div>` : '').join('')}</div>` : ''}</div>`;
}
async function saveMeta(field, value) {
  const patch = {};
  if (field === 'playbook') { patch.playbook = value; patch.followed = []; }
  else if (field === 'followed') patch.followed = value;
  else if (field === 'tags' || field === 'mistakes') patch[field] = value.split(',').map((s) => s.trim()).filter(Boolean);
  else if (field === 'stop') patch.stop = value === '' ? null : Number(value);
  else patch[field] = value;
  const updated = await api('PUT', `/api/trades/${encodeURIComponent(S.openId)}/meta`, patch);
  S.trades = S.trades.map((t) => (t.id === updated.id ? updated : t));
  if (field === 'stop' || field === 'playbook' || field === 'followed') openDrawer(S.openId);
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

// ---------- disciplina ----------
const SEVERITY = { negative: ['Alerta', 'short'], neutral: ['Aviso', ''], positive: ['Bien hecho', 'long'] };
function rulesForm(rules) {
  const on = (k) => (rules[k].on ? 'checked' : '');
  const num = (k, f, step = 'any') => `<input type="number" min="0" step="${step}" name="${k}_${f}" value="${rules[k][f]}" style="width:90px" aria-label="${esc(RULE_LABELS[k])}: ${f}">`;
  return `<form data-form="rules" class="stack">
    <div class="stack" style="gap:10px">
      <label class="row"><input type="checkbox" name="hours_on" ${on('hours')}> <span style="min-width:210px">${RULE_LABELS.hours}</span>
        <input type="time" name="hours_from" value="${rules.hours.from}" aria-label="Desde"> a <input type="time" name="hours_to" value="${rules.hours.to}" aria-label="Hasta"></label>
      <label class="row"><input type="checkbox" name="pause_on" ${on('pause')}> <span style="min-width:210px">${RULE_LABELS.pause}</span>
        tras ${num('pause', 'losses', 1)} seguidas, esperar ${num('pause', 'minutes')} min</label>
      <label class="row"><input type="checkbox" name="maxLossDay_on" ${on('maxLossDay')}> <span style="min-width:210px">${RULE_LABELS.maxLossDay}</span> $ ${num('maxLossDay', 'value')}</label>
      <label class="row"><input type="checkbox" name="maxLossTrade_on" ${on('maxLossTrade')}> <span style="min-width:210px">${RULE_LABELS.maxLossTrade}</span> $ ${num('maxLossTrade', 'value')}</label>
      <label class="row"><input type="checkbox" name="maxTradesDay_on" ${on('maxTradesDay')}> <span style="min-width:210px">${RULE_LABELS.maxTradesDay}</span> ${num('maxTradesDay', 'value', 1)}</label>
    </div><div><button class="btn primary">Guardar reglas</button></div></form>`;
}
function rulesFromForm(data) {
  const f = (k) => data[k];
  return normalizeRules({
    hours: { on: 'hours_on' in data, from: f('hours_from'), to: f('hours_to') },
    pause: { on: 'pause_on' in data, losses: f('pause_losses'), minutes: f('pause_minutes') },
    maxLossDay: { on: 'maxLossDay_on' in data, value: f('maxLossDay_value') },
    maxLossTrade: { on: 'maxLossTrade_on' in data, value: f('maxLossTrade_value') },
    maxTradesDay: { on: 'maxTradesDay_on' in data, value: f('maxTradesDay_value') },
  });
}
function viewDiscipline(el) {
  if (!S.trades.length) { el.innerHTML = emptyState(); return; }
  const [from, to] = rangeBounds();
  const everything = filtered({ ignoreRange: true }).filter((t) => t.status === 'closed');
  const list = everything.filter((t) => t.day >= from && t.day <= to);
  const rulesCard = `<div class="card"><h2>Mis reglas <small>se comprueban solas con cada operación</small></h2>${rulesForm(S.state.settings.rules)}</div>`;
  if (!list.length) { el.innerHTML = noMatch() + rulesCard; return; }

  const ev = evaluateRules(list, S.state.settings.rules, tz());
  const insights = behavioralInsights(everything).filter((i) => i.day >= from && i.day <= to);
  const st = ev.stats;
  const byId = new Map(list.map((t) => [t.id, t]));
  const broken = [...ev.perTrade].map(([id, keys]) => ({ t: byId.get(id), keys })).filter((x) => x.t)
    .sort((a, b) => (a.t.exitTs < b.t.exitTs ? 1 : -1));

  const kpis = ev.active.length ? `<div class="grid kpis">
    ${kpi('Días que cumpliste tus reglas', pct(st.okRate), `${st.okDays} de ${st.days} días`)}
    ${kpi('Operaciones que rompieron reglas', String(st.broke.count), `de ${st.broke.count + st.followed.count} operaciones`)}
    ${kpi('Resultado rompiendo reglas', `<span class="${cls(st.broke.net)}">${money(st.broke.net)}</span>`, st.broke.count ? `${money(st.broke.expectancy)} por operación` : 'sin operaciones')}
    ${kpi('Resultado cumpliendo reglas', `<span class="${cls(st.followed.net)}">${money(st.followed.net)}</span>`, st.followed.count ? `${money(st.followed.expectancy)} por operación` : 'sin operaciones')}
  </div>` : '<div class="notice">No tienes reglas activas. Actívalas abajo para ver cuántos días las cumples y cuánto te cuesta romperlas.</div>';

  const dayRows = ev.days.slice(-30).reverse().map((d) => `<tr>
    <td>${fmtDay(d.day)}</td><td class="r num">${d.count}</td><td class="r num ${cls(d.net)}"><b>${money(d.net)}</b></td>
    ${ev.active.map((k) => `<td>${d.failed.includes(k) ? '<span class="down">✕ Rota</span>' : '<span class="up">✓ Cumplida</span>'}</td>`).join('')}</tr>`).join('');

  const byKind = new Map();
  for (const i of insights) { const g = byKind.get(i.kind) || { n: 0, cost: 0 }; g.n++; g.cost += i.impact; byKind.set(i.kind, g); }
  const patterns = [...byKind].filter(([k]) => k !== 'perfect_day').sort((a, b) => a[1].cost - b[1].cost);
  const shown = insights.slice(0, 40);

  el.innerHTML = `<div class="stack">${kpis}
    ${patterns.length ? `<div class="card"><h2>Patrones que te cuestan dinero <small>resultado de las operaciones afectadas</small></h2><div id="c-patterns"></div></div>` : ''}
    <div class="card"><h2>Insights de comportamiento <small>${insights.length} en este periodo</small></h2>
      ${shown.length ? `<div class="table-wrap"><table><tbody>${shown.map((i) => `<tr class="${i.tradeId ? 'click' : ''}" ${i.tradeId ? `data-action="open" data-id="${esc(i.tradeId)}" tabindex="0"` : ''}>
        <td style="white-space:normal;min-width:260px"><span class="pill ${SEVERITY[i.severity][1]}">${SEVERITY[i.severity][0]}</span> <b>${esc(KIND_LABELS[i.kind])}</b> <span class="muted">· ${fmtDay(i.day)}</span><br><span class="muted">${esc(i.text)}</span></td>
        <td class="r num ${cls(i.impact)}"><b>${money(i.impact)}</b></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty" style="padding:20px">Sin patrones detectados en este periodo. Se necesitan al menos 5 días operados para comparar tu actividad.</div>'}
      ${insights.length > shown.length ? `<p class="muted" style="margin-bottom:0">Se muestran los 40 más recientes.</p>` : ''}</div>
    ${ev.active.length ? `<div class="card"><h2>Reglas día a día <small>últimos ${Math.min(30, ev.days.length)} días operados</small></h2><div class="table-wrap"><table><thead><tr><th>Día</th><th class="r">Op.</th><th class="r">Neto</th>${ev.active.map((k) => `<th>${esc(RULE_LABELS[k])}</th>`).join('')}</tr></thead><tbody>${dayRows}</tbody></table></div></div>` : ''}
    ${broken.length ? `<div class="card"><h2>Operaciones que rompieron reglas <small>${broken.length}</small></h2><div class="table-wrap"><table><tbody>${broken.slice(0, 15).map(({ t, keys }) => `<tr class="click" data-action="open" data-id="${esc(t.id)}" tabindex="0">
      <td class="num">${fmtTime(t.exitTs || t.entryTs)}</td><td>${esc(t.contract)}</td><td>${keys.map((k) => `<span class="pill short">${esc(RULE_LABELS[k])}</span>`).join(' ')}</td>
      <td class="r num ${cls(t.net)}"><b>${money(t.net)}</b></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${rulesCard}</div>`;
  if (patterns.length) {
    hbarChart($('#c-patterns'), patterns.map(([k, g]) => ({
      label: KIND_LABELS[k], value: g.cost, text: money(g.cost),
      tip: `<b class="num">${money(g.cost)}</b>${esc(KIND_LABELS[k])}<br>${g.n} vez/veces en este periodo`,
    })));
  }
}

// ---------- reportes ----------
const REPORTS = {
  symbol: ['Símbolo', (t) => t.root],
  dow: ['Día de la semana', (t) => weekday(t.day), (k) => DOW[k], (a, b) => ((a.key + 6) % 7) - ((b.key + 6) % 7)],
  hour: ['Hora de entrada', (t) => t.hour, (k) => `${String(k).padStart(2, '0')}:00`, (a, b) => a.key - b.key],
  duration: ['Duración', durationBucket, null, (a, b) => DURATION_BUCKETS.findIndex(([n]) => n === a.key) - DURATION_BUCKETS.findIndex(([n]) => n === b.key)],
  side: ['Lado', (t) => (t.side === 'long' ? 'Largos' : 'Cortos')],
  strategy: ['Playbook / estrategia', (t) => pbOf(t.playbook)?.name || t.strategy || 'Sin estrategia'],
  tag: ['Etiqueta', (t) => (t.tags.length ? t.tags : ['Sin etiqueta'])],
  mistake: ['Error', (t) => (t.mistakes.length ? t.mistakes : ['Sin errores'])],
  heat: ['Día × hora'],
};
function viewReports(el) {
  if (!S.trades.length) { el.innerHTML = emptyState(); return; }
  const list = filtered();
  if (S.reportTab === 'heat') return viewHeat(el, list);
  const [title, keyFn, labelFn, sortFn] = REPORTS[S.reportTab];
  const groups = groupStats(list, keyFn).sort(sortFn || ((a, b) => b.net - a.net));
  const label = (g) => (labelFn ? labelFn(g.key) : String(g.key));
  const tabs = reportTabs();
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

function reportTabs() {
  return `<div class="tabs" role="tablist">${Object.entries(REPORTS).map(([k, [l]]) => `<button role="tab" aria-selected="${k === S.reportTab}" data-action="report" data-tab="${k}">${l}</button>`).join('')}</div>`;
}
function viewHeat(el, list) {
  const cells = heatmap(list);
  if (!cells.length) { el.innerHTML = reportTabs() + noMatch(); return; }
  const hours = [...new Set(cells.map((c) => c.hour))].sort((a, b) => a - b);
  const lo = hours[0], hi = hours[hours.length - 1];
  const dows = [1, 2, 3, 4, 5, 6, 0].filter((d) => cells.some((c) => c.dow === d));
  const max = Math.max(...cells.map((c) => Math.abs(c.net))) || 1;
  const at = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const cols = hi - lo + 1;
  let grid = '<div></div>' + Array.from({ length: cols }, (_, i) => `<div class="hl">${String(lo + i).padStart(2, '0')}h</div>`).join('');
  for (const d of dows) {
    grid += `<div class="hl">${DOW[d].slice(0, 3)}</div>`;
    for (let h = lo; h <= hi; h++) {
      const c = at.get(`${d}-${h}`);
      if (!c) { grid += '<div class="c empty-c"></div>'; continue; }
      const a = Math.round(18 + 62 * (Math.abs(c.net) / max));
      grid += `<div class="c" data-tip="1" data-d="${d}" data-h="${h}" style="background:color-mix(in srgb, var(${c.net >= 0 ? '--up' : '--down'}) ${a}%, var(--surface))"><b class="num">${shortMoney(c.net)}</b><span>${c.count} op.</span></div>`;
    }
  }
  el.innerHTML = `${reportTabs()}<div class="card"><h2>Resultado neto por día y hora de entrada <small>hora en ${esc(tz())}</small></h2>
    <div class="table-wrap"><div class="heat" style="--cols:${cols}">${grid}</div></div>
    <p class="muted" style="margin-bottom:0">Cada celda suma el resultado de las operaciones que abriste en ese día y hora. Úsalo para ver en qué franjas ganas y en cuáles pierdes dinero de forma repetida.</p></div>`;
  const wrap = $('.heat', el);
  wrap.onpointermove = (ev) => {
    const c = ev.target.closest('.c[data-tip]');
    if (!c) return hideTip();
    const cell = at.get(`${c.dataset.d}-${c.dataset.h}`);
    const tip = $('#tip');
    tip.innerHTML = `<b class="num">${money(cell.net)}</b>${DOW[cell.dow]} · ${String(cell.hour).padStart(2, '0')}:00<br>${cell.count} operación(es) · acierto ${pct(cell.wins / cell.count)}`;
    tip.hidden = false; tip.style.left = `${ev.clientX + 14}px`; tip.style.top = `${ev.clientY - 60}px`;
  };
  wrap.onpointerleave = hideTip;
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
      ${importsCard()}
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
function importsCard() {
  const list = S.state.imports || [];
  if (!list.length) return '';
  return `<div style="margin:16px 0"><h3 style="margin-bottom:8px">Archivos importados</h3>
    <div class="table-wrap"><table><thead><tr><th>Archivo</th><th>Importado</th><th class="r">Ejecuciones</th><th></th></tr></thead><tbody>
    ${list.map((i) => `<tr><td style="white-space:normal">${esc(i.name)}</td><td class="num">${i.at ? fmtTime(i.at) : '<span class="muted">antes del registro</span>'}</td><td class="r num">${i.fills}</td>
      <td class="r"><button class="btn small danger" data-action="del-import" data-id="${esc(i.id)}" data-n="${i.fills}">Eliminar</button></td></tr>`).join('')}</tbody></table></div>
    <p class="muted" style="margin:8px 0 0">Eliminar un archivo borra todas sus ejecuciones y las operaciones que se forman con ellas, con sus notas. Si una operación tenía ejecuciones en dos archivos, la otra mitad queda como posición abierta.</p></div>`;
}
async function importFiles(files) {
  const account = $('#imp-account')?.value || 'Tradovate';
  for (const f of files) {
    try {
      const r = await api('POST', '/api/import', { csv: await readFile(f, 'text'), account, name: f.name });
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
  const inst = [...S.state.instruments].sort((a, b) => a.root.localeCompare(b.root));
  const used = {};
  for (const t of S.trades) if (t.status === 'closed') { const u = (used[t.root] ||= { contracts: 0, fees: 0, gross: 0 }); u.contracts += t.qty; u.fees += t.fees; u.gross += t.gross; }
  const withTrades = inst.filter((i) => used[i.root]);
  const zones = [...new Set([tz(), 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Caracas', 'Europe/Madrid', 'Europe/London', 'UTC'])];
  const theme = currentTheme();
  el.innerHTML = `<div class="stack">
    <div class="card"><h2>Apariencia</h2><div class="tabs" style="margin:0">
      <button data-action="theme" data-value="dark" aria-pressed="${theme === 'dark'}" aria-selected="${theme === 'dark'}">Tema oscuro</button>
      <button data-action="theme" data-value="light" aria-pressed="${theme === 'light'}" aria-selected="${theme === 'light'}">Tema claro</button></div></div>
    <div class="card"><h2>Zona horaria</h2><div class="row"><select id="set-tz">${zones.map((z) => `<option ${z === tz() ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
      <span class="muted">Define a qué día pertenece cada operación y cómo se leen las horas de los CSV.</span></div></div>
    <div class="card"><h2>Instrumentos y comisiones <small>${S.state.settings.feeMode === 'side' ? 'comisión por contrato en cada lado' : 'comisión por contrato, una sola vez'}</small></h2>
      <p class="muted" style="margin-top:0">El reporte Performance de Tradovate no trae comisiones: indícalas aquí para que el resultado neto sea real. Con la sincronización por API se usan las comisiones exactas de cada ejecución.</p>
      <label class="field" style="max-width:420px;margin-bottom:12px">Cómo te cobra la comisión tu broker
        <select id="set-fee-mode"><option value="round" ${S.state.settings.feeMode !== 'side' ? 'selected' : ''}>Por contrato, una sola vez (ida y vuelta)</option>
          <option value="side" ${S.state.settings.feeMode === 'side' ? 'selected' : ''}>Por contrato en cada lado (entrada y salida)</option></select></label>
      <div class="table-wrap"><table><thead><tr><th>Símbolo</th><th>Nombre</th><th class="r">Valor por punto ($)</th><th class="r">${S.state.settings.feeMode === 'side' ? 'Comisión por lado ($)' : 'Comisión por contrato ($)'}</th><th class="r">Contratos operados</th><th class="r">Comisiones descontadas</th><th></th></tr></thead>
      <tbody>${inst.map((i) => `<tr data-root="${esc(i.root)}"><td><b>${esc(i.root)}</b></td><td class="muted">${esc(i.name)}</td>
        <td class="r"><input type="number" step="any" min="0" value="${i.multiplier}" data-inst="multiplier" style="width:110px;text-align:right" aria-label="Valor por punto de ${esc(i.root)}"></td>
        <td class="r"><input type="number" step="any" min="0" value="${i.fee}" data-inst="fee" style="width:90px;text-align:right" aria-label="Comisión de ${esc(i.root)}"></td>
        <td class="r num">${used[i.root] ? num(used[i.root].contracts, 0) : '—'}</td><td class="r num">${used[i.root] ? money(-used[i.root].fees, { sign: false }) : '—'}</td>
        <td><button class="btn small" data-action="save-inst">Guardar</button></td></tr>`).join('')}
        <tr data-root=""><td><input type="text" placeholder="Nuevo símbolo" data-inst="root" style="width:120px" aria-label="Nuevo símbolo"></td><td></td>
        <td class="r"><input type="number" step="any" min="0" data-inst="multiplier" style="width:110px;text-align:right" aria-label="Valor por punto"></td>
        <td class="r"><input type="number" step="any" min="0" value="0" data-inst="fee" style="width:90px;text-align:right" aria-label="Comisión"></td><td></td><td></td>
        <td><button class="btn small" data-action="save-inst">Añadir</button></td></tr></tbody></table></div>
      ${withTrades.length ? `<div style="margin-top:16px"><h3 style="margin-bottom:6px">Calcular la comisión real con lo que te cobró el broker</h3>
        <p class="muted" style="margin:0 0 8px">Mira en el extracto de Tradovate el total de comisiones y tasas que pagaste por un instrumento en el periodo que has importado y escríbelo aquí. La app calcula la cifra por contrato y por lado y la deja en la tabla para que la guardes. Compara también el <b>resultado bruto</b> con el de tu broker: si el bruto ya no coincide, la diferencia no está en las comisiones.</p>
        <div class="row"><select id="cal-root" aria-label="Instrumento">${withTrades.map((i) => `<option>${esc(i.root)}</option>`).join('')}</select>
          <input type="number" id="cal-total" min="0" step="any" placeholder="Total cobrado ($)" style="width:160px" aria-label="Total cobrado por el broker">
          <button class="btn" data-action="calib">Calcular</button></div>
        <div class="muted num" style="margin-top:8px">${withTrades.map((i) => `${esc(i.root)}: bruto ${money(used[i.root].gross)}`).join(' · ')} · total ${money(withTrades.reduce((a, i) => a + used[i.root].gross, 0))}</div></div>` : ''}</div>
    <div class="card"><h2>Datos</h2><p class="muted" style="margin-top:0">${S.state.dataNote ? esc(S.state.dataNote) : `${S.state.fills} ejecuciones guardadas en <code>data/diario.db</code> (SQLite) y capturas en <code>data/uploads</code>. Haz copia de la carpeta <code>data</code> para respaldar todo.`}</p>
      <div class="row" style="margin-top:12px"><button class="btn danger" data-action="wipe">Borrar todos los datos</button>
        <span class="muted">Elimina operaciones, notas, capturas, playbooks y los instrumentos detectados al importar. Conserva la zona horaria, tus reglas y las comisiones de NQ y MNQ.</span></div></div></div>`;
}

// ---------- playbooks ----------
function armed(el, text) {
  if (el.dataset.armed) return true;
  const original = el.textContent;
  el.dataset.armed = '1'; el.textContent = text;
  setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = original; } }, 5000);
  return false;
}
function pbEditor() {
  const d = S.pbDraft;
  return `<div class="card"><h2>${S.pbNew ? 'Nuevo playbook' : 'Editar playbook'}</h2><div class="stack">
    <label class="field">Nombre<input type="text" data-pb="name" value="${esc(d.name)}" maxlength="80"></label>
    <label class="field">Descripción<textarea data-pb="description" style="min-height:60px" placeholder="¿Cuándo usas este setup y qué busca?">${esc(d.description)}</textarea></label>
    ${d.groups.map((g) => `<div class="card" style="background:var(--surface-2)"><div class="row" style="flex-wrap:nowrap"><input type="text" data-pb-group="${g.id}" value="${esc(g.name)}" style="flex:1;font-weight:600" aria-label="Nombre del grupo"><button class="btn small danger" data-action="pb-del-group" data-gid="${g.id}">Quitar grupo</button></div>
      <div class="stack" style="gap:6px;margin-top:8px">${g.rules.map((r) => `<div class="row" style="flex-wrap:nowrap"><input type="text" data-pb-rule="${r.id}" value="${esc(r.text)}" style="flex:1" aria-label="Regla" placeholder="Escribe la regla"><button class="btn small" data-action="pb-del-rule" data-rid="${r.id}" aria-label="Quitar regla">✕</button></div>`).join('')}
      <div><button class="btn small" data-action="pb-add-rule" data-gid="${g.id}">+ Añadir regla</button></div></div></div>`).join('')}
    <div><button class="btn" data-action="pb-add-group">+ Añadir grupo</button></div>
    <div class="row"><button class="btn primary" data-action="pb-save">Guardar playbook</button><button class="btn" data-action="pb-cancel">Cancelar</button>${S.pbNew ? '' : '<button class="btn danger" data-action="pb-delete">Eliminar playbook</button>'}</div></div></div>`;
}
function pbDetail(pb, list) {
  const st = playbookStats(list, pb);
  const rules = st.rules;
  const best = st.best;
  const sum = st.summary;
  const body = !st.count ? `<div class="empty" style="padding:20px"><strong>Aún no hay operaciones con este playbook</strong>Abre una operación y elígelo en el campo Playbook para marcar qué reglas cumpliste.</div>` : `
    <div class="grid kpis" style="margin-bottom:14px">
      ${kpi('Operaciones', String(st.count), `${sum.wins} ganadoras · ${sum.losses} perdedoras`)}
      ${kpi('Resultado neto', `<span class="${cls(sum.net)}">${money(sum.net)}</span>`, `${money(sum.expectancy)} por operación`)}
      ${kpi('Tasa de acierto', pct(sum.winRate), `factor de beneficio ${sum.profitFactor == null ? '—' : num(sum.profitFactor)}`)}
      ${kpi('Cumplimiento medio', pct(st.adherence), `${rules.length} reglas`)}
    </div>
    ${st.complete.count && st.incomplete.count ? `<div class="notice">Con <b>todas las reglas cumplidas</b> (${st.complete.count} op.): <b class="${cls(st.complete.expectancy)}">${money(st.complete.expectancy)}</b> por operación. Con alguna regla saltada (${st.incomplete.count} op.): <b class="${cls(st.incomplete.expectancy)}">${money(st.incomplete.expectancy)}</b> por operación.</div>` : ''}
    ${best ? `<div class="notice">La regla que más separa tus resultados: <b>«${esc(best.rule.text)}»</b>. Cumplirla rinde ${money(best.rule.followed.expectancy)} por operación y saltártela ${money(best.rule.skipped.expectancy)}.</div>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Regla</th><th class="r">Cumplida</th><th class="r">Neto si la cumples</th><th class="r">Neto si no</th><th class="r">Acierto si la cumples</th><th class="r">Acierto si no</th></tr></thead><tbody>
    ${rules.map((r) => `<tr><td style="white-space:normal;min-width:220px">${esc(r.text)} <span class="muted">· ${esc(r.group)}</span></td><td class="r num">${pct(r.followRate)}</td>
      <td class="r num ${cls(r.followed.net)}">${r.followed.count ? money(r.followed.net) : '—'}</td><td class="r num ${cls(r.skipped.net)}">${r.skipped.count ? money(r.skipped.net) : '—'}</td>
      <td class="r num">${pct(r.followed.winRate)}</td><td class="r num">${pct(r.skipped.winRate)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="card"><h2>${esc(pb.name)} <button class="btn small" data-action="pb-edit">Editar reglas</button></h2>
    ${pb.description ? `<p class="muted" style="margin-top:0">${esc(pb.description)}</p>` : ''}${body}</div>`;
}
function viewPlaybooks(el) {
  const pbs = S.state.settings.playbooks;
  if (!pbs.length && !S.pbDraft) {
    el.innerHTML = `<div class="card empty"><strong>Aún no tienes playbooks</strong>Un playbook es tu estrategia escrita como una lista de reglas. Después marcas en cada operación qué reglas cumpliste y la app te muestra cuáles te hacen ganar dinero.
      <div style="margin-top:14px"><button class="btn primary" data-action="pb-new">Crear con plantilla</button></div></div>`;
    return;
  }
  const list = filtered().filter((t) => t.status === 'closed');
  const unassigned = list.filter((t) => !pbOf(t.playbook)).length;
  const cards = pbs.map((pb) => {
    const st = playbookStats(list, pb);
    return `<button class="card pb-card ${pb.id === S.pbSel ? 'sel' : ''}" data-action="pb-select" data-id="${esc(pb.id)}"><b>${esc(pb.name)}</b>
      <span class="muted">${flatRules(pb).length} reglas · ${st.count} operaciones</span>
      <span class="num ${cls(st.summary.net)}" style="font-size:18px;font-weight:650">${st.count ? money(st.summary.net) : '—'}</span>
      <span class="muted num">Acierto ${pct(st.summary.winRate)} · Cumplimiento ${pct(st.adherence)}</span></button>`;
  }).join('');
  const selected = S.pbSel && !S.pbNew ? pbOf(S.pbSel) : null;
  el.innerHTML = `<div class="stack"><div class="row"><button class="btn primary" data-action="pb-new">Nuevo playbook</button>
      ${S.trades.length ? `<span class="muted">${unassigned} operaciones sin playbook en este periodo.</span>` : ''}</div>
    <div class="grid pb-grid">${cards}</div>
    ${S.pbDraft ? pbEditor() : selected ? pbDetail(selected, list) : '<div class="muted">Elige un playbook para ver el rendimiento de cada una de sus reglas.</div>'}</div>`;
}

// ---------- noticias ----------
const IMPACT = { high: ['Alto', 'short'], medium: ['Medio', 'open'], low: ['Bajo', ''] };
const mondayOf = (day) => addDays(day, -((weekday(day) + 6) % 7));
async function loadNews(key, params) {
  const hit = S.news.cache.get(key);
  if (hit) return;
  S.news.cache.set(key, { loading: true });
  try { S.news.cache.set(key, await api('GET', `/api/economic?${new URLSearchParams(params)}`)); }
  catch (e) { S.news.cache.set(key, { events: [], error: e.message }); }
  if (view() === 'noticias') render();
}
S.calc = { root: '', risk: 100, stop: 10 };
function calcResult() {
  const i = S.state.instruments.find((x) => x.root === S.calc.root);
  if (!i) return '<span class="muted">Elige un instrumento.</span>';
  const r = positionSize({ risk: Number(S.calc.risk), stopPoints: Number(S.calc.stop), multiplier: i.multiplier, fee: i.fee });
  if (!r) return '<span class="muted">Escribe un riesgo y un stop mayores que cero.</span>';
  return `<b class="num" style="font-size:20px">${r.contracts} contrato${r.contracts === 1 ? '' : 's'}</b>
    <div class="muted num">Cada contrato arriesga ${money(r.perContract, { sign: false })} (stop ${money(r.stopDollars, { sign: false })}${i.fee ? ` + comisiones ${money(2 * i.fee, { sign: false })}` : ''}). Riesgo total ${money(r.riskUsed, { sign: false })}.${r.contracts === 0 ? ' Con este riesgo no alcanza ni para un contrato: reduce el stop o sube el riesgo.' : ''}</div>`;
}
function calcCard() {
  const inst = S.state.instruments;
  if (!S.calc.root) S.calc.root = inst.find((i) => i.root === 'MNQ')?.root || inst[0]?.root || '';
  return `<div class="card"><h2>Calculadora de tamaño <small>antes de operar la noticia</small></h2>
    <div class="form-grid"><label class="field">Instrumento<select data-calc="root">${inst.map((i) => `<option ${i.root === S.calc.root ? 'selected' : ''}>${esc(i.root)}</option>`).join('')}</select></label>
      <label class="field">Riesgo máximo ($)<input type="number" min="0" step="any" data-calc="risk" value="${S.calc.risk}"></label>
      <label class="field">Stop (puntos)<input type="number" min="0" step="any" data-calc="stop" value="${S.calc.stop}"></label></div>
    <div id="calc-out" style="margin-top:12px">${calcResult()}</div>
    <p class="muted" style="margin-bottom:0">Usa el valor por punto y la comisión de Ajustes. Redondea hacia abajo para no pasarte del riesgo.</p></div>`;
}
function viewNews(el) {
  const N = S.news;
  if (feat('economicConsent') && !N.enabled) {
    el.innerHTML = `<div class="stack"><div class="card"><h2>Calendario económico</h2>
      <p style="margin-top:0">El calendario se consulta a tu cuenta de Tradezella solo cuando tú lo pides. La consulta envía únicamente fechas, impacto y país, y recibe los eventos del calendario. <b>No lee ni envía tus operaciones, notas ni playbooks.</b> Claude te pedirá permiso la primera vez.</p>
      <button class="btn primary" data-action="news-enable">Cargar calendario</button></div>${calcCard()}</div>`;
    return;
  }
  const w = N.weekStart ||= mondayOf(today());
  const from = w, to = addDays(w, 6);
  const wk = N.cache.get(`w|${from}`);
  if (!wk) loadNews(`w|${from}`, { from, to });
  const nav = `<div class="row"><button class="btn small" data-action="news-week" data-step="-1" aria-label="Semana anterior">‹</button>
    <b>${fmtDay(from)} – ${fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' })}</b>
    <button class="btn small" data-action="news-week" data-step="1" aria-label="Semana siguiente">›</button>
    <button class="btn small" data-action="news-week" data-step="0">Esta semana</button></div>`;
  if (!wk || wk.loading) { el.innerHTML = `<div class="stack"><div class="card">${nav}<div class="empty">Cargando calendario…</div></div>${calcCard()}</div>`; return; }
  const countries = [...new Set(wk.events.map((e) => e.country))].sort();
  if (N.country === null) N.country = countries.includes('US') ? 'US' : countries.includes('USD') ? 'USD' : '';
  const events = wk.events.filter((e) => N.impacts.includes(e.impact) && (!N.country || e.country === N.country));
  const toolbar = `<div class="row">${['high', 'medium', 'low'].map((k) => `<button class="btn small" data-action="news-impact" data-k="${k}" aria-pressed="${N.impacts.includes(k)}" style="${N.impacts.includes(k) ? 'border-color:var(--accent);color:var(--accent-ink)' : ''}">${IMPACT[k][0]}</button>`).join('')}
    <select data-news="country" aria-label="País"><option value="">Todos los países</option>${countries.map((c) => `<option ${c === N.country ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`;
  const byDay = new Map();
  for (const e of events) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
  const t0 = today();
  const mine = (day) => { const ts = S.trades.filter((t) => t.status === 'closed' && t.day === day); return ts.length ? `<span class="muted">Tus operaciones: ${ts.length} · <b class="${cls(ts.reduce((a, t) => a + t.net, 0))}">${money(ts.reduce((a, t) => a + t.net, 0))}</b></span>` : ''; };
  const days = [...byDay.keys()].sort().map((day) => `<div class="card"><h2>${cap(fmtDayLong(day))} ${day === t0 ? '<span class="pill open">Hoy</span>' : ''} ${mine(day)}</h2>
    <div class="table-wrap"><table><thead><tr><th>Hora</th><th>País</th><th>Evento</th><th>Impacto</th><th class="r">Actual</th><th class="r">Previsión</th><th class="r">Anterior</th></tr></thead><tbody>
    ${byDay.get(day).map((e) => `<tr><td class="num">${esc(e.time)}</td><td>${esc(e.country)}</td><td style="white-space:normal;min-width:200px">${esc(e.event)}</td>
      <td><span class="pill ${(IMPACT[e.impact] || ['', ''])[1]}">${esc((IMPACT[e.impact] || [e.impact])[0])}</span></td>
      <td class="r num"><b>${esc(e.actual || '—')}${e.actual ? esc(e.unit) : ''}</b></td><td class="r num">${esc(e.forecast || '—')}</td><td class="r num">${esc(e.previous || '—')}</td></tr>`).join('')}</tbody></table></div></div>`).join('');

  // rendimiento en días de noticias (solo con fuentes que tienen historial)
  let analysis = '';
  const closed = S.trades.filter((t) => t.status === 'closed');
  if (wk.coverage === 'range' && closed.length) {
    const dsorted = closed.map((t) => t.day).sort();
    const aTo = dsorted[dsorted.length - 1];
    const aFrom = [dsorted[0], addDays(aTo, -365)].sort().pop();
    const key = `a|${aFrom}|${aTo}|${N.country}`;
    const ar = N.cache.get(key);
    if (!ar) loadNews(key, { from: aFrom, to: aTo, impact: 'high', ...(N.country ? { countries: N.country } : {}) });
    if (!ar || ar.loading) analysis = '<div class="card"><h2>Tu rendimiento en días de noticias</h2><div class="empty" style="padding:16px">Calculando…</div></div>';
    else if (ar.error) analysis = `<div class="card"><h2>Tu rendimiento en días de noticias</h2><div class="notice warn">${esc(ar.error)}</div></div>`;
    else {
      const r = newsDayStats(closed.filter((t) => t.day >= aFrom && t.day <= aTo), ar.events);
      const side = (title, x) => `<div><h3>${title}</h3><div class="num"><b class="${cls(x.net)}" style="font-size:20px">${money(x.net)}</b></div>
        <div class="muted num">${x.days} días · media ${money(x.avgDay)} por día · ${pct(x.winRate)} días ganadores</div></div>`;
      analysis = `<div class="card"><h2>Tu rendimiento en días de noticias <small>alto impacto${N.country ? ` · ${esc(N.country)}` : ''}</small></h2>
        <div class="grid half">${side('Días con noticias', r.news)}${side('Días sin noticias', r.calm)}</div>
        ${r.byEvent.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Evento (2 o más días)</th><th class="r">Días</th><th class="r">Neto</th><th class="r">Media por día</th><th class="r">Días ganadores</th></tr></thead><tbody>
        ${r.byEvent.map((e) => `<tr><td style="white-space:normal">${esc(e.name)}</td><td class="r num">${e.days}</td><td class="r num ${cls(e.net)}"><b>${money(e.net)}</b></td><td class="r num">${money(e.avgDay)}</td><td class="r num">${pct(e.winRate)}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
    }
  } else if (wk.coverage === 'week') {
    analysis = '<div class="notice">El análisis de tu rendimiento en días de noticias necesita historial del calendario. Esta fuente solo tiene la semana en curso.</div>';
  }
  el.innerHTML = `<div class="stack"><div class="card"><div class="row" style="justify-content:space-between">${nav}${toolbar}</div>
    ${wk.error ? `<div class="notice warn" style="margin:12px 0 0">${esc(wk.error)} <button class="btn small" data-action="news-retry">Reintentar</button></div>` : ''}
    <p class="muted" style="margin:12px 0 0">Fuente: ${esc(wk.source || '')}. ${esc(wk.note || '')}</p></div>
    ${!wk.error && !days ? '<div class="card empty"><strong>Sin eventos con estos filtros</strong>Prueba con otro impacto, país o semana.</div>' : days}
    ${analysis}${calcCard()}</div>`;
}

// ---------- asistente ----------
function mdLite(text) {
  const inline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = null, table = null;
  const flush = () => { if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; } if (table) { out.push(tableHtml(table)); table = null; } };
  const tableHtml = (rows) => {
    const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const body = rows.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
    const [head, ...rest] = body;
    return `<div class="table-wrap"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td style="white-space:normal">${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  for (const line of String(text).split('\n')) {
    if (/^\s*\|/.test(line)) { if (list) flush(); (table ||= []).push(line); continue; }
    if (table) flush();
    const li = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) flush();
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}
/** Resumen compacto del diario para el asistente (solo si el usuario lo activa). */
function journalSummary(days) {
  const from = addDays(today(), -days);
  const list = S.trades.filter((t) => t.status === 'closed' && t.day >= from);
  const s = summarize(list);
  const group = (fn) => groupStats(list, fn).map((g) => ({ clave: g.key, operaciones: g.count, neto: Math.round(g.net * 100) / 100, acierto: g.winRate == null ? null : Math.round(g.winRate * 100) }));
  const ev = evaluateRules(list, S.state.settings.rules, tz());
  const kinds = {};
  for (const i of behavioralInsights(list).filter((x) => x.day >= from)) kinds[KIND_LABELS[i.kind]] = (kinds[KIND_LABELS[i.kind]] || 0) + 1;
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    periodo: `${from} a ${today()}`, operaciones: s.count, neto: r2(s.net), acierto: s.winRate == null ? null : Math.round(s.winRate * 100),
    factorBeneficio: r2(s.profitFactor), expectativaPorOperacion: r2(s.expectancy), gananciaMedia: r2(s.avgWin), perdidaMedia: r2(s.avgLoss),
    drawdownMaximo: r2(s.maxDrawdown), diasOperados: s.tradingDays,
    porDiaSemana: group((t) => DOW[weekday(t.day)]), porHoraEntrada: group((t) => `${String(t.hour).padStart(2, '0')}:00`),
    cumplimientoReglas: { diasCumplidos: ev.stats.okDays, dias: ev.stats.days, resultadoRompiendoReglas: r2(ev.stats.broke.net), operacionesRompiendoReglas: ev.stats.broke.count },
    patronesDetectados: kinds,
  };
}
const AI_PROMPTS = [
  ['Analiza el premercado de hoy', 'market'], ['¿Qué noticias importantes hay hoy y esta semana, y cómo pueden mover el NQ?', 'market'],
  ['¿Cómo cerró ayer el NQ y qué niveles importan hoy?', 'market'], ['Resume mis últimos 30 días y dime qué debo mejorar', 'journal'],
];
function aiMessagesHtml() {
  const A = S.ai;
  if (!A.messages.length) return '<div class="empty" style="padding:24px"><strong>Pregúntame lo que necesites del mercado</strong>Activa los datos de mercado y pídeme el análisis del premercado, el calendario del día o los niveles del NQ.</div>';
  return A.messages.map((m, i) => {
    const last = i === A.messages.length - 1;
    return m.role === 'user' ? `<div class="bubble me">${esc(m.content).replace(/\n/g, '<br>')}</div>`
      : `<div class="bubble ai ${m.error ? 'err' : ''}" ${last ? 'id="ai-last"' : ''}>${m.content ? mdLite(m.content) : '<span class="muted">Pensando…</span>'}</div>`;
  }).join('');
}
function viewAssistant(el) {
  const A = S.ai;
  if (A.available === null) {
    if (!globalThis.ASSISTANT) A.available = false;
    else { globalThis.ASSISTANT.isAvailable().then((ok) => { A.available = ok; if (view() === 'asistente') render(); }); el.innerHTML = '<div class="empty">Comprobando el asistente…</div>'; return; }
  }
  if (!A.available) {
    el.innerHTML = `<div class="card empty"><strong>El asistente no está disponible aquí</strong>Funciona en la página publicada en Claude, donde usa a Claude con datos de mercado reales. En la versión con servidor propio no está incluido.</div>`;
    return;
  }
  el.innerHTML = `<div class="stack"><div class="card"><h2>Qué datos puede usar el asistente</h2>
      <label class="row" style="flex-wrap:nowrap;align-items:flex-start;margin-bottom:8px"><input type="checkbox" data-ai-toggle="market" ${A.market ? 'checked' : ''}> <span><b>Datos de mercado</b>: velas de precio y calendario económico, consultados a tu conector de Tradezella. Solo envían símbolo, fechas e impacto; no leen tus operaciones, notas ni playbooks. Claude te pedirá permiso la primera vez.</span></label>
      <label class="row" style="flex-wrap:nowrap;align-items:flex-start"><input type="checkbox" data-ai-toggle="journal" ${A.journal ? 'checked' : ''}> <span><b>Resumen de mi diario</b>: el asistente puede leer un resumen de tus estadísticas de esta app (no tus notas ni las ejecuciones una a una).</span></label></div>
    <div class="row">${AI_PROMPTS.map(([q, need]) => `<button class="btn small" data-action="ai-prompt" data-q="${esc(q)}" ${A.busy || !A[need] ? 'disabled' : ''} title="${A[need] ? '' : need === 'market' ? 'Activa los datos de mercado' : 'Activa el resumen de tu diario'}">${esc(q)}</button>`).join('')}</div>
    <div class="card"><div id="ai-chat" class="chat">${aiMessagesHtml()}</div>
      <div id="ai-status" class="muted" style="min-height:20px;margin-top:8px">${esc(A.status)}</div>
      <form data-form="ai" class="row" style="flex-wrap:nowrap;align-items:flex-end;margin-top:8px"><textarea name="q" rows="2" style="min-height:44px" placeholder="Pregunta sobre el premercado, el calendario, un nivel o tu operativa…" aria-label="Pregunta" ${A.busy ? 'disabled' : ''}></textarea>
        ${A.busy ? '<button type="button" class="btn" data-action="ai-stop">Detener</button>' : '<button class="btn primary">Enviar</button>'}</form>
      <p class="muted" style="margin:8px 0 0;font-size:12px">Análisis educativo con datos reales cuando las herramientas responden; no es una recomendación de inversión. ${A.messages.length ? '<a href="#asistente" data-action="ai-clear">Borrar conversación</a>' : ''}</p></div></div>`;
  const chat = $('#ai-chat'); if (chat) chat.scrollTop = chat.scrollHeight;
}
const AI_ERRORS = {
  not_granted: 'No has dado permiso para usar Claude en esta página. Recarga y acepta cuando se te pregunte.',
  sampling_disabled: 'Claude no está disponible para tu cuenta en esta página.',
  rate_limited: 'Has llegado al límite de uso. Espera un momento antes de preguntar de nuevo.',
  tools_unavailable: 'Esta vista no permite que el asistente consulte datos. Abre la página en claude.ai.',
  prompt_too_large: 'La conversación es demasiado larga. Borra la conversación y vuelve a empezar.',
};
async function sendAi(raw) {
  const A = S.ai, q = String(raw || '').trim();
  if (A.busy || !q) return;
  A.messages.push({ role: 'user', content: q }, { role: 'assistant', content: '' });
  A.busy = true; A.status = 'Pensando…'; A.ctl = new AbortController();
  render();
  const last = () => A.messages[A.messages.length - 1];
  const paint = () => { const b = $('#ai-last'); if (b) { b.innerHTML = last().content ? mdLite(last().content) : '<span class="muted">Pensando…</span>'; const c = $('#ai-chat'); if (c) c.scrollTop = c.scrollHeight; } };
  const history = A.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.error ? '(La respuesta anterior falló.)' : m.content }));
  try {
    const r = await globalThis.ASSISTANT.ask(history, {
      market: A.market, journal: A.journal, journalFn: journalSummary, tz: tz(), signal: A.ctl.signal,
      onText: ({ text }) => { last().content = text; paint(); },
      onStatus: (t) => { A.status = t; const s = $('#ai-status'); if (s) s.textContent = t; },
    });
    last().content = r.text || last().content;
    if (r.truncated) last().content += '\n\n_La respuesta se cortó. Pídeme que continúe o que sea más breve._';
  } catch (e) {
    if (e?.code === 'cancelled') { if (!last().content) A.messages.splice(-2, 2); }
    else { last().error = true; last().content = (e?.text ? `${e.text}\n\n` : '') + (AI_ERRORS[e?.code] || 'No se pudo completar la respuesta. Inténtalo de nuevo.'); }
  } finally {
    A.busy = false; A.status = ''; A.ctl = null;
    if (view() === 'asistente') render();
  }
}

// ---------- eventos ----------
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!S.needLogin) toast(e.message); } };

document.addEventListener('click', guard(async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'open') { if (!ev.target.closest('[data-sel]')) openDrawer(el.dataset.id); }
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
    const next = el.dataset.value || (currentTheme() === 'dark' ? 'light' : 'dark');
    document.documentElement.dataset.theme = next;
    if (view() === 'ajustes') render();
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

// acciones de playbooks, noticias, asistente y borrado de datos
document.addEventListener('click', guard(async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const D = S.pbDraft;
  const group = () => D?.groups.find((g) => g.id === el.dataset.gid);
  if (a === 'pb-new') { S.pbDraft = playbookTemplate(uid); S.pbSel = S.pbDraft.id; S.pbNew = true; render(); }
  else if (a === 'pb-select') { S.pbSel = el.dataset.id; S.pbDraft = null; S.pbNew = false; render(); }
  else if (a === 'pb-edit') { S.pbDraft = structuredClone(pbOf(S.pbSel)); S.pbNew = false; render(); }
  else if (a === 'pb-add-group') { D.groups.push({ id: uid(), name: 'Nuevo grupo', rules: [] }); render(); }
  else if (a === 'pb-add-rule') { group().rules.push({ id: uid(), text: '' }); render(); }
  else if (a === 'pb-del-group') { D.groups = D.groups.filter((g) => g.id !== el.dataset.gid); render(); }
  else if (a === 'pb-del-rule') { for (const g of D.groups) g.rules = g.rules.filter((r) => r.id !== el.dataset.rid); render(); }
  else if (a === 'pb-cancel') { if (S.pbNew) S.pbSel = null; S.pbDraft = null; S.pbNew = false; render(); }
  else if (a === 'pb-save') {
    if (!D.name.trim()) { toast('Ponle un nombre al playbook.'); return; }
    const all = S.state.settings.playbooks;
    const list = S.pbNew ? [...all, D] : all.map((p) => (p.id === D.id ? D : p));
    S.state = await api('PUT', '/api/settings', { playbooks: list });
    S.pbDraft = null; S.pbNew = false; toast('Playbook guardado.'); render();
  } else if (a === 'pb-delete') {
    if (!armed(el, 'Confirmar: eliminar playbook')) return;
    S.state = await api('PUT', '/api/settings', { playbooks: S.state.settings.playbooks.filter((p) => p.id !== D.id) });
    S.pbDraft = null; S.pbSel = null; S.pbNew = false; toast('Playbook eliminado.'); render();
  } else if (a === 'sel-filtered') { for (const t of filtered()) S.sel.add(t.id); render(); }
  else if (a === 'sel-clear') { S.sel.clear(); render(); }
  else if (a === 'calib') {
    const root = $('#cal-root').value, total = Number($('#cal-total').value);
    const contracts = S.trades.filter((t) => t.status === 'closed' && t.root === root).reduce((n, t) => n + t.qty, 0);
    if (!(total > 0) || !contracts) { toast('Escribe el total que te cobró el broker.'); return; }
    const sides = S.state.settings.feeMode === 'side' ? 2 : 1;
    const perUnit = Math.round((total / (sides * contracts)) * 10000) / 10000;
    const input = $(`tr[data-root="${root}"] [data-inst=fee]`);
    input.value = perUnit; input.focus(); input.style.outline = '2px solid var(--accent)';
    toast(`${root}: ${money(total, { sign: false })} entre ${contracts} contratos${sides === 2 ? ' y 2 lados' : ''} = $${perUnit} por contrato${sides === 2 ? ' y lado' : ''}. Pulsa Guardar en su fila.`);
  }
  else if (a === 'del-selected') {
    const n = S.sel.size;
    if (!armed(el, `Confirmar: eliminar ${n} ${n === 1 ? 'operación' : 'operaciones'} para siempre`)) return;
    const r = await api('POST', '/api/trades/delete', { ids: [...S.sel] });
    S.sel.clear(); S.openId = null;
    toast(r.deleted === 1 ? '1 operación eliminada.' : `${r.deleted} operaciones eliminadas.`);
    await reload();
  } else if (a === 'del-import') {
    if (!armed(el, `Confirmar: borrar ${el.dataset.n} ejecuciones`)) return;
    const r = await api('DELETE', `/api/imports/${encodeURIComponent(el.dataset.id)}`);
    S.sel.clear(); S.openId = null; S.calMonth = null;
    toast(`Archivo eliminado: ${r.fills} ${r.fills === 1 ? 'ejecución' : 'ejecuciones'} y ${r.trades} ${r.trades === 1 ? 'operación' : 'operaciones'}.`);
    await reload();
  } else if (a === 'news-enable') { S.news.enabled = true; render(); }
  else if (a === 'news-week') {
    const step = Number(el.dataset.step);
    S.news.weekStart = step === 0 ? mondayOf(today()) : addDays(S.news.weekStart, step * 7);
    render();
  } else if (a === 'news-impact') {
    const k = el.dataset.k, cur = S.news.impacts;
    S.news.impacts = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    render();
  } else if (a === 'news-retry') { S.news.cache.clear(); render(); }
  else if (a === 'ai-prompt') { await sendAi(el.dataset.q); }
  else if (a === 'ai-stop') { S.ai.ctl?.abort(); }
  else if (a === 'ai-clear') { ev.preventDefault(); S.ai.messages = []; render(); }
  else if (a === 'wipe') {
    if (!armed(el, 'Confirmar: borrar todo, no se puede deshacer')) return;
    S.state = await api('DELETE', '/api/data', { confirm: 'BORRAR' });
    S.trades = await api('GET', '/api/trades');
    S.openId = null; S.pbSel = null; S.pbDraft = null; S.calMonth = null; S.news.cache.clear();
    toast('Todos los datos se borraron. Empiezas desde cero.'); render();
  }
}));

document.addEventListener('input', (ev) => {
  const el = ev.target, D = S.pbDraft;
  if (D && el.dataset.pb) D[el.dataset.pb] = el.value;
  else if (D && el.dataset.pbGroup) D.groups.find((g) => g.id === el.dataset.pbGroup).name = el.value;
  else if (D && el.dataset.pbRule) { for (const g of D.groups) for (const r of g.rules) if (r.id === el.dataset.pbRule) r.text = el.value; }
  else if (el.dataset.calc) { S.calc[el.dataset.calc] = el.value; const o = $('#calc-out'); if (o) o.innerHTML = calcResult(); }
});

document.addEventListener('change', guard(async (ev) => {
  const el = ev.target;
  if ('sel' in el.dataset) { if (el.checked) S.sel.add(el.dataset.sel); else S.sel.delete(el.dataset.sel); render(); }
  else if ('selAll' in el.dataset) {
    const ids = [...document.querySelectorAll('tbody [data-sel]')].map((c) => c.dataset.sel);
    for (const id of ids) { if (el.checked) S.sel.add(id); else S.sel.delete(id); }
    render();
  } else if ('follow' in el.dataset) {
    const ids = [...document.querySelectorAll('#drawer [data-follow]:checked')].map((c) => c.value);
    await saveMeta('followed', ids);
  } else if (el.dataset.aiToggle) { S.ai[el.dataset.aiToggle] = el.checked; render(); }
  else if (el.dataset.news === 'country') { S.news.country = el.value; render(); }
  else if (el.id === 'set-fee-mode') {
    S.state = await api('PUT', '/api/settings', { feeMode: el.value });
    S.trades = await api('GET', '/api/trades');
    toast(el.value === 'round' ? 'Las comisiones se cobran una vez por contrato. Resultados recalculados.' : 'Las comisiones se cobran en cada lado. Resultados recalculados.');
    render();
  }
  else if (el.dataset.calc) { S.calc[el.dataset.calc] = el.value; const o = $('#calc-out'); if (o) o.innerHTML = calcResult(); }
}));

document.addEventListener('submit', guard(async (ev) => {
  const form = ev.target.closest('[data-form=ai]');
  if (!form) return;
  ev.preventDefault();
  const q = new FormData(form).get('q');
  form.reset();
  await sendAi(q);
}));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && ev.target.matches?.('form[data-form=ai] textarea')) { ev.preventDefault(); ev.target.form.requestSubmit(); }
});

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
  } else if (form.dataset.form === 'rules') {
    S.state = await api('PUT', '/api/settings', { rules: rulesFromForm(data) });
    toast('Reglas guardadas.'); render();
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
