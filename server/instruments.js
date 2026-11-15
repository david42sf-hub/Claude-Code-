// Valor por punto de los futuros más operados. Se puede editar desde Ajustes.
export const DEFAULT_INSTRUMENTS = [
  ['ES', 'E-mini S&P 500', 50], ['MES', 'Micro E-mini S&P 500', 5],
  ['NQ', 'E-mini Nasdaq-100', 20], ['MNQ', 'Micro E-mini Nasdaq-100', 2],
  ['YM', 'E-mini Dow', 5], ['MYM', 'Micro E-mini Dow', 0.5],
  ['RTY', 'E-mini Russell 2000', 50], ['M2K', 'Micro E-mini Russell 2000', 5],
  ['CL', 'Crude Oil', 1000], ['MCL', 'Micro Crude Oil', 100], ['QM', 'E-mini Crude Oil', 500],
  ['NG', 'Natural Gas', 10000], ['MNG', 'Micro Natural Gas', 1000],
  ['GC', 'Gold', 100], ['MGC', 'Micro Gold', 10],
  ['SI', 'Silver', 5000], ['SIL', 'Micro Silver', 1000],
  ['HG', 'Copper', 25000], ['MHG', 'Micro Copper', 2500],
  ['ZB', '30-Year T-Bond', 1000], ['ZN', '10-Year T-Note', 1000],
  ['ZF', '5-Year T-Note', 1000], ['ZT', '2-Year T-Note', 2000],
  ['6E', 'Euro FX', 125000], ['M6E', 'Micro Euro FX', 12500],
  ['6B', 'British Pound', 62500], ['6J', 'Japanese Yen', 12500000],
  ['6A', 'Australian Dollar', 100000], ['6C', 'Canadian Dollar', 100000],
  ['BTC', 'Bitcoin', 5], ['MBT', 'Micro Bitcoin', 0.1],
  ['ETH', 'Ether', 50], ['MET', 'Micro Ether', 0.1],
  ['ZC', 'Corn', 50], ['ZS', 'Soybeans', 50], ['ZW', 'Wheat', 50],
];

/** "MNQZ6" -> "MNQ". Si no parece un contrato de futuros devuelve el símbolo tal cual. */
export function rootOf(contract) {
  const c = String(contract || '').trim().toUpperCase();
  const m = c.match(/^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  return m ? m[1] : c;
}
