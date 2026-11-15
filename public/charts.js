// Gráficos SVG sin dependencias: línea con cursor, columnas con signo y barras horizontales.

const tip = () => document.getElementById('tip');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showTip(html, x, y) {
  const el = tip();
  el.innerHTML = html; el.hidden = false;
  const r = el.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 10;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 16;
  el.style.left = `${Math.max(8, left)}px`; el.style.top = `${top}px`;
}
export function hideTip() { const el = tip(); if (el) el.hidden = true; }

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}

const axisMoney = (v, compact) => {
  const a = Math.abs(v);
  const body = compact ? (a >= 1e6 ? `${+(a / 1e6).toFixed(1)}M` : `${+(a / 1e3).toFixed(1)}K`) : a.toLocaleString('en-US');
  return `${v < 0 ? '−' : ''}$${a === 0 ? '0' : body}`;
};

function frame(el, values, height) {
  const W = Math.max(280, el.clientWidth), H = height;
  const { lo, hi, ticks } = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const compact = Math.max(Math.abs(lo), Math.abs(hi)) >= 10000;
  const m = { l: compact ? 52 : 58, r: 12, t: 10, b: 24 };
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
  const grid = ticks.map((t) => `<line class="${t === 0 ? 'zero' : 'grid-line'}" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>
    <text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${axisMoney(t, compact)}</text>`).join('');
  return { W, H, m, y, grid };
}

function xLabels(points, x, H, W) {
  const n = points.length;
  const max = Math.max(2, Math.floor(W / 90));
  const idx = n <= max ? points.map((_, i) => i) : Array.from({ length: max }, (_, k) => Math.round((k * (n - 1)) / (max - 1)));
  return [...new Set(idx)].map((i) => {
    const anchor = i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle';
    return `<text x="${x(i)}" y="${H - 6}" text-anchor="${anchor}">${esc(points[i].label)}</text>`;
  }).join('');
}

/** Línea acumulada. points: [{label, value, tip}] */
export function lineChart(el, points, { height = 240 } = {}) {
  const draw = () => {
    const f = frame(el, points.map((p) => p.value), height);
    const { W, H, m, y } = f;
    const n = points.length;
    const x = (i) => (n === 1 ? (m.l + W - m.r) / 2 : m.l + ((W - m.l - m.r) * i) / (n - 1));
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const area = `${path}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Curva de capital">
      ${f.grid}${xLabels(points, x, H, W)}
      <path class="area" d="${area}"/><path class="series" d="${path}"/>
      <circle class="dot" r="4" cx="${x(n - 1)}" cy="${y(points[n - 1].value)}"/>
      <g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/><circle class="dot" r="5"/></g>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></svg>`;
    const svg = el.querySelector('svg'), hover = svg.querySelector('.hover');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
      hover.style.display = '';
      hover.querySelector('line').setAttribute('x1', x(i)); hover.querySelector('line').setAttribute('x2', x(i));
      hover.querySelector('circle').setAttribute('cx', x(i)); hover.querySelector('circle').setAttribute('cy', y(points[i].value));
      showTip(points[i].tip, ev.clientX, ev.clientY);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', () => { hover.style.display = 'none'; hideTip(); });
  };
  observe(el, draw);
}

/** Columnas positivas/negativas. items: [{label, value, tip}] */
export function columnChart(el, items, { height = 240 } = {}) {
  const draw = () => {
    const f = frame(el, items.map((p) => p.value), height);
    const { W, H, m, y } = f;
    const band = (W - m.l - m.r) / items.length;
    const bw = Math.max(1, Math.min(24, band - 2));
    const x = (i) => m.l + band * (i + 0.5);
    const y0 = y(0);
    const cols = items.map((p, i) => {
      const yv = y(p.value), h = Math.abs(yv - y0), r = Math.min(4, bw / 2, h);
      const l = x(i) - bw / 2, rt = l + bw;
      const d = p.value >= 0
        ? `M${l},${y0}V${yv + r}Q${l},${yv} ${l + r},${yv}H${rt - r}Q${rt},${yv} ${rt},${yv + r}V${y0}Z`
        : `M${l},${y0}V${yv - r}Q${l},${yv} ${l + r},${yv}H${rt - r}Q${rt},${yv} ${rt},${yv - r}V${y0}Z`;
      return `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${H - m.t - m.b}"/>
        <path class="${p.value >= 0 ? 'col-up' : 'col-down'}" d="${d}" pointer-events="none"/>`;
    }).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Resultado por día">
      ${f.grid}${xLabels(items, x, H, W)}${cols}</svg>`;
    const svg = el.querySelector('svg');
    svg.addEventListener('pointermove', (ev) => {
      const i = ev.target.dataset?.i;
      if (i == null) return hideTip();
      showTip(items[i].tip, ev.clientX, ev.clientY);
    });
    svg.addEventListener('pointerleave', hideTip);
  };
  observe(el, draw);
}

/** Barras horizontales con signo, con el valor al final de cada fila. items: [{label, value, text, tip}] */
export function hbarChart(el, items) {
  const min = Math.min(0, ...items.map((i) => i.value)), max = Math.max(0, ...items.map((i) => i.value));
  const span = max - min || 1;
  const zero = (-min / span) * 100;
  el.innerHTML = `<div class="hbars" style="--zero:${zero}%">${items.map((it, i) => {
    const w = (Math.abs(it.value) / span) * 100;
    const left = it.value >= 0 ? zero : zero - w;
    return `<div class="hbar" data-i="${i}"><span class="name" title="${esc(it.label)}">${esc(it.label)}</span>
      <span class="track"><span class="bar ${it.value >= 0 ? 'pos' : 'neg'}" style="left:${left}%;width:${w}%"></span></span>
      <span class="val num">${esc(it.text)}</span></div>`;
  }).join('')}</div>`;
  el.onpointermove = (ev) => {
    const row = ev.target.closest('.hbar');
    if (!row) return hideTip();
    showTip(items[row.dataset.i].tip, ev.clientX, ev.clientY);
  };
  el.onpointerleave = hideTip;
}

const observers = new WeakMap();
function observe(el, draw) {
  observers.get(el)?.disconnect();
  let last = 0;
  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w && w !== last) { last = w; draw(); }
  });
  ro.observe(el);
  observers.set(el, ro);
}
