// Datos ficticios para ver cómo funciona la app. Determinista: la misma semilla da los mismos datos.
// Incluye a propósito días de sobreoperación, de venganza, operaciones fuera de horario, un día perfecto,
// playbooks con reglas marcadas, notas y errores, para que todas las secciones tengan algo que mostrar.
import { wallToUtc, dayKey } from '../server/time.js';

const NY = 'America/New_York';
export const DEMO_BATCH = 'demo';

export function demoPlaybooks() {
  const g = (id, name, rules) => ({ id, name, rules: rules.map((text, i) => ({ id: `${id}-r${i + 1}`, text })) });
  return [
    {
      id: 'demo-pb1', name: 'Ruptura de apertura',
      description: 'Ruptura del rango de los primeros 15 minutos con volumen, entrando en el retesteo.',
      groups: [
        g('demo-a', 'Condiciones de mercado', ['Hay volumen por encima de lo normal en la apertura', 'El rango inicial de 15 minutos es claro']),
        g('demo-b', 'Entrada', ['Una vela cierra por fuera del rango', 'Entro en el retesteo, sin perseguir el precio']),
        g('demo-c', 'Salida y riesgo', ['El stop está puesto antes de entrar', 'El objetivo mínimo es 2R']),
      ],
    },
    {
      id: 'demo-pb2', name: 'Reversión a VWAP',
      description: 'Operación contra un movimiento extendido cuando el precio se aleja del VWAP.',
      groups: [
        g('demo-d', 'Condiciones de mercado', ['El precio está claramente extendido respecto al VWAP', 'No hay noticias de alto impacto en los próximos 30 minutos']),
        g('demo-e', 'Entrada y salida', ['Hay señal de agotamiento antes de entrar', 'El objetivo es el VWAP y el stop está más allá del extremo']),
      ],
    },
  ];
}

const NOTES = [
  'Buena lectura del contexto, esperé la confirmación.', 'Entré antes de tiempo y me sacó el stop.',
  'Respeté el plan de principio a fin.', 'Moví el stop y lo pagué. Revisar esta regla.',
  'Día lateral, debí operar menos.', 'La noticia de las 8:30 movió todo; esperé a que se calmara.',
];
const MISTAKES = ['Entrada tardía', 'Sin plan', 'Movió el stop', 'Sobreoperó'];
const DAY_NOTES = [
  'Plan: solo ruptura de apertura, máximo 3 operaciones. Salí a la hora.',
  'Me costó esperar la confirmación. Mañana, alarma a las 9:25.',
  'Día de noticias: reduje el tamaño a la mitad y funcionó.',
  'Perdí la disciplina después de la segunda pérdida. Pausa de 5 minutos la próxima vez.',
];

export function makeDemo(now = new Date(), tz = NY, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const roundTick = (v) => Math.round(v * 4) / 4;

  const month = now.getUTCMonth();
  const suffix = `${['H', 'H', 'H', 'M', 'M', 'M', 'U', 'U', 'U', 'Z', 'Z', 'Z'][month]}${now.getUTCFullYear() % 10}`;
  const playbooks = demoPlaybooks();
  const rulesOf = (pb) => pb.groups.flatMap((g) => g.rules.map((r) => r.id));

  // últimos 60 días naturales, solo días de semana (algunos sin operar)
  const today = dayKey(now, NY);
  const days = [];
  for (let back = 1; back <= 60; back++) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    if ([0, 6].includes(d.getUTCDay())) continue;
    if (rnd() < 0.1) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  days.reverse(); // del más antiguo al más reciente
  const n = days.length;
  const special = new Map([[n - 6, 'over'], [n - 12, 'revenge'], [n - 19, 'perfect'], [n - 3, 'revenge']]);

  const fills = [], meta = {}, dayNotes = {};
  let fid = 0;
  const price = (di) => 26200 + di * 9 + (rnd() - 0.5) * 500;

  const addTrade = (day, di, spec) => {
    const [y, mo, d] = day.split('-').map(Number);
    const long = spec.long, dir = long ? 1 : -1;
    const entry = roundTick(price(di));
    const exit = roundTick(entry + dir * (spec.win ? spec.pts : -spec.pts));
    const at = (min, sec) => wallToUtc(y, mo, d, Math.floor(min / 60), min % 60, sec, NY).toISOString();
    const contract = spec.inst + suffix;
    const id1 = `demo-${++fid}`, id2 = `demo-${++fid}`;
    const base = { account: 'Demo', contract, qty: spec.qty, fee: null, source: 'csv', batch: DEMO_BATCH };
    fills.push({ ...base, id: id1, side: long ? 'B' : 'S', price: entry, ts: at(spec.start, int(0, 59)) });
    fills.push({ ...base, id: id2, side: long ? 'S' : 'B', price: exit, ts: at(spec.start + spec.dur, int(0, 59)) });

    // metadatos: playbook, reglas cumplidas (más a menudo en las ganadoras), stop, errores y notas
    if (rnd() < 0.75) {
      const pb = pick(playbooks);
      const ids = rulesOf(pb);
      meta[id1] = {
        playbook: pb.id, followed: ids.filter(() => rnd() < (spec.win ? 0.88 : 0.5)),
        stop: roundTick(entry - dir * (spec.inst === 'NQ' ? int(12, 30) : int(10, 25))),
        tags: rnd() < 0.5 ? ['A+'] : rnd() < 0.5 ? ['B'] : [],
        mistakes: !spec.win && rnd() < 0.5 ? [pick(MISTAKES)] : [],
        notes: rnd() < 0.12 ? pick(NOTES) : '', strategy: '',
      };
    }
  };

  const mk = (inst, win, extra = {}) => {
    const big = !win && rnd() < 0.04;
    const pts = inst === 'NQ' ? (win ? int(15, 90) : int(10, 45)) : (win ? int(12, 70) : int(8, 35));
    return { inst, long: rnd() < 0.55, win, pts: big ? pts * 3 : pts, qty: inst === 'NQ' ? int(1, 2) : int(1, 5), dur: int(1, 40), ...extra };
  };

  days.forEach((day, di) => {
    const kind = special.get(di);
    let clock = int(9 * 60 + 32, 10 * 60 + 15);
    const specs = [];
    if (kind === 'over') {
      for (let k = 0; k < 7; k++) { specs.push(mk('MNQ', k < 2, { qty: int(1, 2), dur: int(1, 6) })); }
    } else if (kind === 'revenge') {
      specs.push(mk('NQ', false, { qty: 1, dur: int(3, 12) }), mk('NQ', false, { qty: 2, dur: int(2, 6), gapBefore: int(1, 3) }), mk('NQ', false, { qty: 2, dur: int(2, 6), gapBefore: int(1, 3) }));
    } else if (kind === 'perfect') {
      for (let k = 0; k < 3; k++) specs.push(mk(rnd() < 0.7 ? 'MNQ' : 'NQ', true));
    } else {
      const count = int(1, 4);
      for (let k = 0; k < count; k++) specs.push(mk(rnd() < 0.62 ? 'MNQ' : 'NQ', rnd() < 0.55));
    }
    specs.forEach((sp, k) => {
      if (k > 0) clock += sp.gapBefore ?? int(4, 35);     // tiempo entre el cierre anterior y esta entrada
      sp.start = clock;
      addTrade(day, di, sp);
      clock += sp.dur;
    });
    // a veces una operación fuera de horario (antes de la apertura o ya tarde)
    if (!kind && rnd() < 0.12) addTrade(day, di, { ...mk('MNQ', rnd() < 0.4), start: int(8 * 60, 8 * 60 + 40), dur: int(2, 15) });
    if (!kind && rnd() < 0.08) addTrade(day, di, { ...mk('MNQ', rnd() < 0.4), start: int(15 * 60 + 35, 15 * 60 + 50), dur: int(2, 8) });
  });

  // notas del diario en algunos de los últimos días
  days.slice(-8).forEach((day, i) => { if (i % 2 === 0) dayNotes[day] = DAY_NOTES[(i / 2) % DAY_NOTES.length]; });

  return {
    fills, meta, days: dayNotes, playbooks,
    instruments: { NQ: { name: '', multiplier: 20, fee: 1.29 }, MNQ: { name: '', multiplier: 2, fee: 0.39 } },
  };
}
