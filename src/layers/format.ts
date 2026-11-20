/** 距離の表示文字列。1km 未満は整数メートル、それ以上は km（小数1桁）。 */
export function formatDistance(meters: number): string {
  const m = Math.round(meters);
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

/** 名前の末尾が suffix でなければ付ける（「渋谷」→「渋谷駅」、「渋谷駅」はそのまま）。 */
export function withSuffix(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

/** 重複を除き、最初に現れた順を保つ。 */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
