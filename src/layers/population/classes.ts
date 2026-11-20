/**
 * 人口密度（人/km²）の段階区分と配色。純粋関数のみ。
 * 区切りは固定値。実データは低い側に偏るので、低い側ほど細かく切る。
 */

export type RGB = [number, number, number];

/** 人口 0（無居住）のメッシュの色。最も低い段より暗い。 */
export const ZERO_COLOR: RGB = [24, 26, 36];

export interface DensityClass {
  /** この段の下限（人/km²、含む） */
  min: number;
  /** この段の上限（人/km²、含まない）。最上段は null */
  max: number | null;
  color: RGB;
}

/** 暗い青 → 明るい黄。段が上がるごとに相対輝度が単調に増える。 */
export const DENSITY_CLASSES: readonly DensityClass[] = [
  { min: 0, max: 1000, color: [28, 40, 104] },
  { min: 1000, max: 3000, color: [30, 70, 150] },
  { min: 3000, max: 6000, color: [22, 108, 168] },
  { min: 6000, max: 10000, color: [34, 146, 156] },
  { min: 10000, max: 15000, color: [98, 176, 122] },
  { min: 15000, max: 20000, color: [190, 204, 84] },
  { min: 20000, max: null, color: [252, 238, 96] },
];

/** 人が住んでいる（密度が正の有限値）か。 */
export function isPopulated(density: number): boolean {
  return Number.isFinite(density) && density > 0;
}

/** 密度に対応する段の番号。無居住・不正値は -1。 */
export function densityClassIndex(density: number): number {
  if (!isPopulated(density)) return -1;
  for (let i = DENSITY_CLASSES.length - 1; i >= 0; i--) if (density >= DENSITY_CLASSES[i].min) return i;
  return 0;
}

export function densityColor(density: number): RGB {
  const i = densityClassIndex(density);
  return i < 0 ? ZERO_COLOR : DENSITY_CLASSES[i].color;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 凡例（無居住 → 低密度 → 高密度の順）。 */
export function densityLegend(): { color: RGB; label: string }[] {
  return [
    { color: ZERO_COLOR, label: '0（人が住んでいない）' },
    ...DENSITY_CLASSES.map((c, i) => ({
      color: c.color,
      label:
        c.max === null ? `${fmt(c.min)}以上 人/km²` : i === 0 ? `〜${fmt(c.max)} 人/km²` : `${fmt(c.min)}〜${fmt(c.max)} 人/km²`,
    })),
  ];
}
