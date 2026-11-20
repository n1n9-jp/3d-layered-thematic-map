import type { ProbeValue } from '../types';

/** 値の表示。値がなければ「—」、数値は桁区切りを入れ、単位があれば後ろに付ける。 */
export function formatValue(v: ProbeValue): string {
  if (v.value === null) return '—';
  return `${typeof v.value === 'number' ? v.value.toLocaleString('ja-JP') : v.value}${v.unit ? ` ${v.unit}` : ''}`;
}
