// Valor por punto de los futuros más operados. Se puede editar desde Ajustes.
// Solo los instrumentos que se operan. Cualquier otro se añade desde Ajustes o se detecta al importar un CSV.
export const DEFAULT_INSTRUMENTS = [
  ['NQ', 'E-mini Nasdaq-100', 20], ['MNQ', 'Micro E-mini Nasdaq-100', 2],
];

/** "MNQZ6" -> "MNQ". Si no parece un contrato de futuros devuelve el símbolo tal cual. */
export function rootOf(contract) {
  const c = String(contract || '').trim().toUpperCase();
  const m = c.match(/^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  return m ? m[1] : c;
}
