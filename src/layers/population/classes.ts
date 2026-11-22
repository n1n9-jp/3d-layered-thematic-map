/**
 * 人口密度（人/km²）の段階区分と配色。純粋関数のみ。
 * 区切りは固定値で、23区の250mメッシュ（人口あり 8,420セル）の分布に合わせ、
 * 5,000人/km²刻み（最上段は30,000以上）。各段のセル数は 685〜2,033 に収まる。
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
  { min: 0, max: 5000, color: [28, 40, 104] },
  { min: 5000, max: 10000, color: [30, 70, 150] },
  { min: 10000, max: 15000, color: [22, 108, 168] },
  { min: 15000, max: 20000, color: [34, 146, 156] },
  { min: 20000, max: 25000, color: [98, 176, 122] },
  { min: 25000, max: 30000, color: [190, 204, 84] },
  { min: 30000, max: null, color: [252, 238, 96] },
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

/* ---------- 65歳以上（人口密度で塗る） ---------- */

/**
 * 65歳以上の人口密度（65歳以上人口 ÷ メッシュの面積。人/km²）の段階区分と配色。
 * 区切りは、23区の250mメッシュ（65歳以上が分かる 9,386 個）の分布に合わせた固定値で、1,000 刻み（4,000〜5,000 の次は 6,500）。
 * 65歳以上が 0 のメッシュ（1,126 個）を除いて、各段のメッシュ数は 612〜1,899 に収まる。
 * 総人口の配色（青 → 黄）とは別の、暗い紫 → 橙の並びにして、切り替えたときに取り違えない。
 */
export const ELDERLY_CLASSES: readonly DensityClass[] = [
  { min: 0, max: 1000, color: [62, 30, 108] },
  { min: 1000, max: 2000, color: [102, 36, 128] },
  { min: 2000, max: 3000, color: [146, 42, 132] },
  { min: 3000, max: 4000, color: [188, 54, 120] },
  { min: 4000, max: 5000, color: [222, 86, 98] },
  { min: 5000, max: 6500, color: [243, 134, 82] },
  { min: 6500, max: null, color: [252, 192, 92] },
];

/** 65歳以上が 0 人のメッシュの色（人口 0 と同じ暗い色）。 */
export const ELDERLY_ZERO_COLOR: RGB = ZERO_COLOR;
/** 65歳以上が不明（秘匿されたメッシュ）の色。段のどれとも違う、くすんだ灰色。 */
export const ELDERLY_UNKNOWN_COLOR: RGB = [118, 122, 132];

/** 65歳以上の人口密度に対応する段の番号。0 や不正値は -1。 */
export function elderlyClassIndex(density: number): number {
  if (!Number.isFinite(density) || !(density > 0)) return -1;
  for (let i = ELDERLY_CLASSES.length - 1; i >= 0; i--) if (density >= ELDERLY_CLASSES[i].min) return i;
  return 0;
}

/** 65歳以上の人口密度（人/km²）の色。null（不明）は灰色、0 は暗い色。 */
export function elderlyColor(density: number | null): RGB {
  if (density === null) return ELDERLY_UNKNOWN_COLOR;
  const i = elderlyClassIndex(density);
  return i < 0 ? ELDERLY_ZERO_COLOR : ELDERLY_CLASSES[i].color;
}

/** 65歳以上の凡例（不明 → 0 → 低密度 → 高密度の順は使わず、無居住 → 低 → 高、最後に不明）。 */
export function elderlyLegend(): { color: RGB; label: string }[] {
  return [
    { color: ELDERLY_ZERO_COLOR, label: '0（65歳以上がいない）' },
    ...ELDERLY_CLASSES.map((c, i) => ({
      color: c.color,
      label:
        c.max === null ? `${fmt(c.min)}以上 人/km²` : i === 0 ? `〜${fmt(c.max)} 人/km²` : `${fmt(c.min)}〜${fmt(c.max)} 人/km²`,
    })),
    { color: ELDERLY_UNKNOWN_COLOR, label: '不明（国勢調査で秘匿）' },
  ];
}
