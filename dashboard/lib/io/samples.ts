// Sample portfolio offered as CSV and XLSX downloads: an SPY iron condor plus a
// longer-dated call, so the import demonstrates mixed expiries. Blank premiums
// fall back to model prices.

export const SAMPLE_ROWS: (string | number)[][] = [
  ['symbol', 'type', 'side', 'strike', 'days', 'qty', 'premium'],
  ['SPY', 'put',  'buy',  715, 47, 5, ''],
  ['SPY', 'put',  'sell', 735, 47, 5, ''],
  ['SPY', 'call', 'sell', 775, 47, 5, ''],
  ['SPY', 'call', 'buy',  795, 47, 5, ''],
  ['SPY', 'call', 'buy',  760, 90, 2, ''],
];

export const SAMPLE_CSV = SAMPLE_ROWS.map(r => r.join(',')).join('\n') + '\n';
