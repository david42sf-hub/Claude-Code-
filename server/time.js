// Utilidades de zona horaria sin dependencias.

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Componentes de fecha/hora de un instante en la zona `tz`. */
export function tzParts(date, tz) {
  const p = {};
  for (const x of fmt(tz).formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

export function dayKey(date, tz) {
  const p = tzParts(date, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Convierte una hora "de reloj" en la zona `tz` a un instante UTC. */
export function wallToUtc(y, mo, d, h, mi, s, tz) {
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(t), tz);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - target;
    if (diff === 0) break;
    t -= diff;
  }
  return new Date(t);
}

/**
 * Interpreta una marca de tiempo de un CSV o formulario.
 * Acepta ISO con zona (se respeta), o formatos sin zona que se leen como hora local en `tz`:
 * "MM/DD/YYYY HH:mm[:ss] [AM|PM]", "YYYY-MM-DD HH:mm[:ss]", "YYYY-MM-DDTHH:mm".
 */
export function parseTimestamp(raw, tz) {
  const str = String(raw ?? '').trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(str)) {
    const d = new Date(str);
    return isNaN(d) ? null : d;
  }
  let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?$/);
  if (m) {
    let h = +m[4];
    if (m[7]) { const pm = /p/i.test(m[7]); h = (h % 12) + (pm ? 12 : 0); }
    return wallToUtc(+m[3], +m[1], +m[2], h, +m[5], +(m[6] || 0), tz);
  }
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (m) return wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
  return null;
}
